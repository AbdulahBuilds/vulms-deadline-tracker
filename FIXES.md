# 🛠️ VULMS Smart Deadline Tracker — Architectural Fixes & Enhancements

This document details the engineering challenges identified in the original requirements and how our production architecture resolves them with robust, zero-cost solutions.

---

## 1. Google Apps Script CORS & 302 Redirect Failure

### The Issue
- When a browser extension calls `fetch()` with `Content-Type: application/json`, the browser issues a preliminary HTTP `OPTIONS` preflight request.
- Google Apps Script Web Apps (`https://script.google.com/macros/s/.../exec`) do not support `OPTIONS` preflight and return an HTTP `405 Method Not Allowed` or fail CORS headers.
- Furthermore, Apps Script responds to valid `POST` requests with an HTTP `302 Found` redirect to a temporary sandbox domain (`script.googleusercontent.com`).

### Our Solution
1. In `service_worker.js`, requests send stringified JSON using `Content-Type: text/plain;charset=utf-8` and explicit redirect following:
   ```javascript
   const response = await fetch(webAppUrl, {
     method: "POST",
     headers: { "Content-Type": "text/plain;charset=utf-8" },
     body: JSON.stringify(payload),
     redirect: "follow"
   });
   ```
2. Sending `text/plain` qualifies as a CORS-safelisted request under the Fetch specification, preventing the browser from triggering an `OPTIONS` preflight.
3. In `apps-script/Code.js`, `doPost(e)` parses the text body seamlessly:
   ```javascript
   var payload = JSON.parse(e.postData.contents);
   ```

---

## 2. Exact 12:00 PM PKT Delivery vs. Loose 1-Hour Windows

### The Issue
- Google Apps Script's built-in daily timer (`ScriptApp.newTrigger().timeBased().atHour(12)`) runs randomly inside an entire 60-minute window (any time between 12:00 PM and 1:00 PM).
- It cannot guarantee delivery close to 12:00:00 PM.

### Our Solution: Hourly Trigger + Noon Gatekeeper
1. We install a trigger that runs **every hour**:
   ```javascript
   ScriptApp.newTrigger('checkAndSendReminders')
     .timeBased()
     .everyHours(1)
     .create();
   ```
2. Inside `checkAndSendReminders()`, we check the current time in the `Asia/Karachi` timezone:
   ```javascript
   var pktString = Utilities.formatDate(new Date(), "Asia/Karachi", "yyyy-MM-dd HH:mm");
   var currentHour = parseInt(pktString.substring(11, 13), 10);

   if (currentHour < 12) {
     return; // Gatekeeper holds dispatch until 12:00 PM noon PKT
   }
   ```
3. When the trigger runs at the 12:00 PM hour, all activities with `end_date === currentPktDate` and `reminder_status === "pending"` are dispatched immediately and marked `sent`. Subsequent runs (1 PM, 2 PM) skip already sent rows, ensuring zero duplicate emails.

---

## 3. Concurrency Locking & Race Condition Prevention

### The Issue
- When a student launches their browser, multiple pinned tabs (e.g., VULMS Home, CS101 page, MTH101 page) open concurrently.
- Each tab's content script attempts to extract and sync data to Google Sheets at the exact same second, causing duplicate row insertions.

### Our Solution: Apps Script LockService
In `apps-script/Code.js`, execution is wrapped with `LockService.getScriptLock()`:
```javascript
var lock = LockService.getScriptLock();
try {
  lock.waitLock(30000); // Wait up to 30s for lock
  var result = processSyncPayload(payload);
  return jsonResponse(result);
} finally {
  lock.releaseLock();
}
```
All concurrent sync requests queue cleanly and process sequentially, guaranteeing atomic upserts.

---

## 4. Resilient Dynamic DOM Observation

### The Issue
- VULMS uses ASP.NET and dynamic AJAX/DOM injection to populate To-Do calendar widgets.
- Traditional `DOMContentLoaded` scraping runs too early, finding an empty table and failing to detect upcoming activities.

### Our Solution
In `extension/content/content.js`:
1. We attach a `MutationObserver` to watch for DOM injections.
2. We back this with a bounded polling mechanism (up to 12 attempts spaced by 1.2s).
3. Once valid activities are extracted, the observer is cleanly disconnected to conserve browser memory.
4. If a page has 0 items (e.g. during semester breaks), the extension **never** deletes existing database records.

---

## 5. VULMS 24-Hour "Grace Day" Handling

### The Issue
- VULMS frequently grants an automatic 24-hour extension on assignments.
- If a reminder was already sent for the original deadline, a simple system would either ignore the extension or fail to re-alert the student.

### Our Solution
In `processSyncPayload()`:
- If `end_date` increases and `reminder_status === "sent"`:
  - `end_date` is updated to the extended date.
  - `reminder_status` transitions to `pending_extended`.
- On the extended due date at 12:00 PM, a revised reminder is sent with the subject banner:
  `🚨 [EXTENDED DEADLINE] VULMS Deadline Alert: [CS101] Assignment 1 Due Today`.

---

## 6. Ingestion-Time Filtering for Late Discovery

### The Issue
- If a student installs the tracker midway through a semester, old activities from previous months are present in their LMS calendar.
- A naive scheduler would see their due date as past and might flood the student with dozens of overdue emails.

### Our Solution
During ingestion, we compare the activity's deadline with current PKT date:
```javascript
var todayPkt = Utilities.formatDate(now, "Asia/Karachi", "yyyy-MM-dd");
if (activity.end_date < todayPkt) {
  row.status = "overdue";
  row.reminder_status = "skipped_past_deadline";
} else {
  row.status = "active";
  row.reminder_status = "pending";
}
```
Only active and future deadlines ever receive email reminders.

---

## 7. Multi-Student Data Isolation & 1-Click Distribution

### The Issue
- A centralized database architecture incurs server hosting costs and creates legal/privacy liabilities with student academic data.

### Our Solution
- **Decentralized Architecture**: Each student possesses their own private Google Sheet and their own Apps Script deployment.
- **Privacy**: Student credentials, LMS links, and activity dates never leave their personal Google account.
- **Cost**: 100% free forever for all students.
- **1-Click Activation**: The custom `🚀 VULMS Tracker` menu inside Google Sheets automates trigger creation with zero coding required by the student.
