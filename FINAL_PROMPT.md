# Project: VULMS Smart Deadline Tracker & Email Reminder System (Final Specification)

## 1. Project Objective

Build a 100% free, zero-maintenance, automated deadline tracking and notification system for students using the Virtual University of Pakistan Learning Management System (VULMS).

The system must automatically extract assignments, quizzes, GDBs, and other activities from the VULMS To-Do Calendar whenever a student logs in to or navigates VULMS.

It must save the extracted data, prevent duplicate records, detect changes or deadline extensions, and send an automatic email reminder at **12:00 PM (noon) Pakistan Standard Time (PKT) on the exact end date of each activity**.

The system gives students approximately 12 hours of buffer time to submit their work before standard 11:59 PM deadlines.

The system is designed for multi-student use (the developer and their friends), ensuring complete data privacy, personal Google account isolation, and near-zero onboarding friction.

---

## 2. Technology Stack & Protocol Specifications

### Chrome Extension (Manifest V3)
- **Manifest**: Chrome Extension Manifest V3.
- **Frontend / Scripts**: Vanilla JavaScript (ES6+), HTML5, CSS3.
- **Content Scripts**: Non-intrusive scraping with dynamic `MutationObserver` to observe asynchronous VULMS calendar rendering.
- **Background Service Worker**: Handles persistent synchronization queues, local Chrome storage caching, and network retries.
- **Extension Popup**: Clean, responsive glassmorphism UI displaying sync status, student badge, activity statistics, manual sync triggers, and settings.

### Google Sheets Database
- Acts as the free, persistent database for all activity records.
- Pre-structured columns with strict ISO date formats (`YYYY-MM-DD`) and status state machines.

### Google Apps Script (Backend & Scheduler)
- **Web App Endpoint (`doPost`)**: Receives synchronization payloads from the extension.
- **Concurrency Locking**: Uses Apps Script `LockService` to prevent race conditions and duplicate inserts from concurrent tab opens.
- **Cloud Scheduler**: Independent time-driven triggers executing in Google Cloud regardless of whether the student's browser or computer is on.
- **Gmail Service (`GmailApp`)**: Dispatches branded, responsive HTML reminder emails within Google's free quotas.

---

## 3. Web App Communication & CORS Protocol (Fix Integrated)

### Problem Addressed
Google Apps Script Web Apps (`https://script.google.com/macros/s/.../exec`) do not respond to HTTP `OPTIONS` preflight requests. Sending `Content-Type: application/json` causes browser `OPTIONS` preflights that Apps Script rejects with CORS errors. In addition, Apps Script responds to valid `POST` requests with an HTTP `302 Found` redirect.

### Technical Requirement
1. **Extension Client**:
   All sync requests from the Chrome Extension background worker must send the stringified JSON payload with `Content-Type: text/plain;charset=utf-8` and explicit redirect following:
   ```javascript
   const response = await fetch(webAppUrl, {
     method: "POST",
     headers: {
       "Content-Type": "text/plain;charset=utf-8"
     },
     body: JSON.stringify(payload),
     redirect: "follow" // Follow 302 redirect to script.googleusercontent.com
   });
   ```
2. **Apps Script Web App**:
   The `doPost(e)` entry point parses the incoming text body:
   ```javascript
   function doPost(e) {
     var payload = JSON.parse(e.postData.contents);
     // Process synchronized activities
   }
   ```

---

## 4. Automatic Extraction & Resilient DOM Observer (Fix Integrated)

Whenever a student logs in to VULMS or opens the relevant Dashboard / To-Do Calendar page:

1. **Authentication & Student ID Detection**:
   - Detect whether the student is authenticated.
   - Extract the student's ID (e.g., `bc210...`) from the VULMS navigation header profile element or badge (`#lblStudentId` / `.user-profile span`).
2. **Dynamic DOM Observer (No Premature Scraping)**:
   - VULMS loads calendar widgets asynchronously via AJAX/DOM injection.
   - Do not rely on a single static `DOMContentLoaded` selector.
   - Implement a `MutationObserver` with a bounded retry polling mechanism (e.g., up to 10 attempts spaced by 1 second) to wait until activity items are fully populated.
3. **Multi-Selector Fallback Strategy**:
   - Primary: To-Do widget tables/cards (`#toDoList`, `.todo-calendar`, `table.todo`).
   - Secondary: Notification items and course dashboard activity badges.
4. **Data Captured per Activity**:
   - Activity Title (e.g., "Assignment No. 1", "Quiz 1").
   - Course Code & Name (e.g., "CS101 - Introduction to Computing").
   - Activity Type (`Assignment`, `Quiz`, `GDB`, etc.).
   - Start Date & End Date (normalized to `YYYY-MM-DD`).
   - Activity URL / submission link when available.
   - Stable VULMS activity ID if present.
5. **Safe Handling of Incomplete Extraction**:
   - If 0 items are extracted due to a network glitch or empty semester break, the extension must **never** treat this as proof that existing activities were deleted.

---

## 5. Duplicate Prevention & Concurrency Locking (Fix Integrated)

### Deterministic Activity Key
Every activity is identified by a unique composite key:
$$\text{activity\_key} = \text{MD5 or Base64}(\text{student\_id} + \text{"\_"} + \text{course\_code} + \text{"\_"} + \text{activity\_type} + \text{"\_"} + \text{activity\_title})$$
If VULMS provides a stable activity ID, prefer:
$$\text{activity\_key} = \text{student\_id} + \text{"\_"} + \text{vulms\_activity\_id}$$

### Concurrency Lock in Apps Script
When a student opens multiple VULMS tabs simultaneously, each tab triggers a sync request. Apps Script must enforce atomic writes using `LockService`:
```javascript
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Wait up to 30 seconds for lock
    lock.waitLock(30000);

    var payload = JSON.parse(e.postData.contents);
    var result = processSyncPayload(payload);

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
```

### Upsert Rules
- If `activity_key` does not exist $\rightarrow$ **Insert new row**.
- If `activity_key` exists and details/deadline are unchanged $\rightarrow$ **Skip (no-op)**.
- If `activity_key` exists and deadline has changed $\rightarrow$ **Update row and reschedule reminder**.

---

## 6. Exact 12:00 PM Pakistan Time Reminder Scheduling (Fix Integrated)

### Problem Addressed
Google Apps Script's daily trigger (`atHour(12)`) runs randomly inside a 1-hour window (between 12:00 PM and 1:00 PM). It cannot guarantee execution at 12:00:00 PM.

### Technical Solution: Hourly Trigger + Noon Gatekeeper
1. Install an **hourly time-driven trigger** in Apps Script.
2. The trigger executes `checkAndSendReminders()`.
3. The function checks the current hour in the `Asia/Karachi` time zone:
   ```javascript
   function checkAndSendReminders() {
     var now = new Date();
     var pktString = Utilities.formatDate(now, "Asia/Karachi", "yyyy-MM-dd HH:mm");
     var currentPktDate = pktString.substring(0, 10); // 'YYYY-MM-DD'
     var currentHour = parseInt(pktString.substring(11, 13), 10); // 0-23

     // Do not dispatch before 12:00 PM noon PKT
     if (currentHour < 12) {
       return;
     }

     var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Activities");
     var data = sheet.getDataRange().getValues();

     for (var i = 1; i < data.length; i++) {
       var row = data[i];
       var endDate = Utilities.formatDate(new Date(row[8]), "Asia/Karachi", "yyyy-MM-dd");
       var reminderStatus = row[12]; // Col M: reminder_status

       if (reminderStatus === "pending" && endDate === currentPktDate) {
         sendReminderEmail(row);
         sheet.getRange(i + 1, 13).setValue("sent");
         sheet.getRange(i + 1, 14).setValue(new Date());
       }
     }
   }
   ```
4. This guarantees that on the due date, as soon as noon PKT arrives, the scheduled run dispatches the email promptly.

---

## 7. Handling VULMS "Grace Day" (Extended 24 Hours) & Rescheduled Deadlines (Fix Integrated)

VULMS frequently grants an automatic 24-hour grace extension for assignments. The system must handle deadline shifts gracefully:

1. **Deadline Extended (Not Yet Sent)**:
   - If `end_date` increases from Nov 9 to Nov 10 and `reminder_status == "pending"`, update `end_date = "2026-11-10"` and keep `reminder_status = "pending"`.
   - The email will automatically trigger on Nov 10 at 12:00 PM.
2. **Deadline Extended (Already Sent for Original Date)**:
   - If the student was already emailed on Nov 9, and VULMS later adds a 24-hour extension to Nov 10:
   - Update `end_date = "2026-11-10"`.
   - Set `reminder_status = "pending_extended"`.
   - On Nov 10 at noon, dispatch a special subject: `[EXTENDED DEADLINE] VULMS Reminder: CS101 Assignment 1 Due Today`.
3. **Cancelled or Deleted Activities**:
   - If VULMS explicitly marks an activity as cancelled, update `status = "cancelled"` and `reminder_status = "skipped_cancelled"`.

---

## 8. Ingestion-Time Filtering for Late-Discovered & Past-Due Items (Fix Integrated)

If a student installs the extension midway through a semester, old activities from previous weeks will be present in the calendar.

**Ingestion Rule**:
```javascript
var todayPkt = Utilities.formatDate(new Date(), "Asia/Karachi", "yyyy-MM-dd");
if (activityEndDate < todayPkt) {
  // Activity expired in the past
  row.status = "overdue";
  row.reminder_status = "skipped_past_deadline";
} else {
  row.status = "active";
  row.reminder_status = "pending";
}
```
This guarantees students never receive unexpected email floods for activities that ended prior to extension installation.

---

## 9. Multi-Student Architecture & Low-Friction Onboarding (Fix Integrated)

### Privacy Principle
Each student has their own personal Google Sheet and their own Apps Script deployment. No central database, no sharing of student credentials, no exposure of private grades or dates.

### Low-Friction Onboarding Model (3 Steps for Friends):
1. **1-Click Google Sheet Copy**:
   - Provide a template link: `https://docs.google.com/spreadsheets/d/{TEMPLATE_ID}/copy`.
   - The template includes the sheet schema and the embedded `Code.gs` script.
2. **One-Click Script Authorization**:
   - Inside the copied sheet, a custom menu appears:
     `VULMS Tracker > 🚀 Authorize & Activate Scheduler`.
   - Clicking this automatically builds the hourly time-driven trigger without the student ever touching code.
3. **Deploy as Web App**:
   - The friend clicks `Deploy > New deployment > Web App > Execute as: Me > Who has access: Anyone`.
   - They paste the generated URL into their extension popup.

---

## 10. Email Design & Content Requirements

Reminders must look professional, clean, and legible on both mobile and desktop.

### Example Template:
* **Subject**: `🚨 VULMS Deadline Alert: [CS101] Assignment 2 Due Today`
* **Preheader**: `Approximately 12 hours remaining before 11:59 PM deadline.`
* **Body Elements**:
  - Greeting with Student Name (if configured) or Student ID.
  - Course Code & Name.
  - Activity Title & Type badge (Assignment, Quiz, GDB).
  - Target Due Date & Estimated Submission Deadline (11:59 PM PKT).
  - Clear Call-to-Action button: `Open VULMS Activity`.
  - Footer notice: `Automated alert by VULMS Smart Deadline Tracker`.

---

## 11. Chrome Extension Popup & User Interface

The extension popup must provide a high-clarity dashboard:
- **Connection Indicator**: Green badge (`Connected`), Amber (`Syncing`), Red (`Error / Disconnected`).
- **Student Profile**: Shows detected Student ID (e.g., `bc210401234`).
- **Sync Metrics**:
  - Last synced timestamp.
  - Total activities tracked.
  - Number of pending reminders.
- **Next Reminder Card**: Highlight the next upcoming deadline and countdown.
- **Manual "Sync Now" Button**: Triggers immediate extraction on the active VULMS tab.
- **Settings Panel**:
  - Google Apps Script Web App URL input.
  - Secret Sync Passphrase input.
  - Optional student display name.
  - Test Connection & Send Test Email button.

---

## 12. Google Sheets Database Schema

| Column Index | Column Header | Data Type | Description / Constraints |
|---|---|---|---|
| A (1) | `student_id` | String | e.g., `bc210400000` |
| B (2) | `activity_key` | String | Deterministic unique hash |
| C (3) | `vulms_activity_id` | String | LMS ID if available, else empty |
| D (4) | `course_code` | String | e.g., `CS101` |
| E (5) | `course_name` | String | e.g., `Introduction to Computing` |
| F (6) | `activity_title` | String | e.g., `Assignment No. 1` |
| G (7) | `activity_type` | String | `Assignment`, `Quiz`, `GDB` |
| H (8) | `start_date` | Date (`YYYY-MM-DD`) | Activity opening date |
| I (9) | `end_date` | Date (`YYYY-MM-DD`) | Deadline date |
| J (10) | `activity_url` | String | Direct link to activity |
| K (11) | `status` | String | `active`, `overdue`, `cancelled` |
| L (12) | `reminder_datetime` | DateTime | Target timestamp (Noon PKT) |
| M (13) | `reminder_status` | String | `pending`, `sent`, `skipped_past_deadline`, `pending_extended` |
| N (14) | `reminder_sent_at` | DateTime | Timestamp when email was successfully sent |
| O (15) | `created_at` | DateTime | Initial record insertion time |
| P (16) | `updated_at` | DateTime | Last record modification time |
| Q (17) | `last_synced_at` | DateTime | Last time seen in VULMS sync |

---

## 13. Acceptance Testing Matrix (Tests A through J)

1. **Test A (New Activity)**: First discovery inserts exactly 1 row with `reminder_status = "pending"`.
2. **Test B (Duplicate Sync)**: Syncing the same 5 activities 10 times results in 0 duplicate rows.
3. **Test C (Future Activity)**: Activity discovered on Nov 2 with end date Nov 9 schedules for Nov 9 at 12:00 PM PKT.
4. **Test D (Deadline Extended)**: End date modified from Nov 9 to Nov 10 updates the row and reschedules reminder to Nov 10.
5. **Test E (Duplicate Email Guard)**: Trigger running every hour sends the email once at noon and skips subsequent runs.
6. **Test F (Offline Resilience)**: Laptop closed or turned off; Google Apps Script trigger executes in cloud and dispatches email on schedule.
7. **Test G (Scraper Interruption)**: Empty page load or network drop does not wipe or corrupt existing records.
8. **Test H (Multi-Student Isolation)**: Student A and Student B use independent Web Apps/Sheets; zero cross-contamination.
9. **Test I (Timezone Accuracy)**: Date math evaluates against `Asia/Karachi` regardless of user local system time.
10. **Test J (Late Discovery)**: Activity already past its deadline is tagged `skipped_past_deadline` with no email sent.

---

## 14. Project File Structure to be Created

```text
vulms-tracker/
├── extension/
│   ├── manifest.json
│   ├── icons/
│   │   ├── icon16.png
│   │   ├── icon48.png
│   │   └── icon128.png
│   ├── content/
│   │   ├── content.js          # Observes DOM and triggers scraper
│   │   └── extractor.js        # VULMS HTML parser & date normalizer
│   ├── background/
│   │   └── service_worker.js   # Background worker, sync queue, fetch handler
│   └── popup/
│       ├── popup.html          # Modern glassmorphism UI
│       ├── popup.css           # Styling
│       └── popup.js            # Popup controller & storage sync
├── apps-script/
│   ├── Code.js                 # Web App doPost, LockService, and reminder engine
│   ├── EmailTemplate.html      # Responsive HTML email
│   └── appsscript.json         # Timezone configuration (Asia/Karachi)
├── docs/
│   ├── SETUP_GUIDE.md          # 3-step friend onboarding walkthrough
│   └── SPREADSHEET_TEMPLATE.md # Instructions to copy pre-made sheet
├── PLAN.md                     # Phased roadmap
├── FIXES.md                    # Detailed fixes reference
└── FINAL_PROMPT.md             # This unified master prompt
```
