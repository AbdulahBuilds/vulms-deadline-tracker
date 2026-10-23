# 🛠️ VULMS Tracker — Troubleshooting & FAQ

This guide answers common questions and helps resolve edge cases quickly.

---

## 1. Google OAuth Warning: "Google hasn't verified this app"

### Why does this appear?
When you authorize the script in your Google Sheet, Google displays a security warning because the script has not undergone Google's commercial verification process. **This is completely normal and expected for personal private scripts that you own and run in your own account.**

### How to proceed:
1. On the warning screen, click the small link at the bottom: **Advanced**.
2. Click **Go to Untitled project (unsafe)** (or the name of your script).
3. Review the permissions requested (`Spreadsheets`, `Gmail`, `Triggers`) and click **Allow**.
4. None of your data leaves your personal Google account.

---

## 2. Chrome Extension shows "Connection Failed" or "Failed to fetch"

### Root Cause & Fix:
1. **Did you deploy as Web App with "Who has access: Anyone"?**
   - In Apps Script: Click **Deploy** &gt; **Manage deployments**.
   - Ensure **Execute as** is set to `Me (your email)`.
   - Ensure **Who has access** is set to `Anyone`. If set to "Only myself", browser extension requests cannot authenticate without complex OAuth headers.
2. **Did you copy the `/exec` URL?**
   - Correct: `https://script.google.com/macros/s/AKfycb.../exec`
   - Incorrect: `.../dev` (test URLs require developer cookies and will fail).
3. **CORS Preflight Bypass**:
   - The extension uses `Content-Type: text/plain;charset=utf-8` and `redirect: "follow"`. This guarantees that Google Apps Script's 302 redirect is seamlessly followed without triggering preflight rejection.

---

## 3. What if my computer is turned off at 12:00 PM PKT?

**You will still receive your email on time!**
- The reminder engine runs inside **Google Cloud servers** via a Google Apps Script time-driven trigger.
- The trigger executes independently 24/7. Your laptop or PC can be turned off, asleep, or disconnected from the internet.

---

## 4. Are there any costs or Gmail quota limits?

- **Cost**: **$0.00 (100% Free forever)**.
- **Gmail Quota**: Google provides **100 free outbound emails per day** for standard personal `@gmail.com` accounts (and 1,500/day for Google Workspace).
- Even with 6 enrolled VU courses, you will rarely receive more than 1–2 deadline alerts per day, consuming less than **2% of your daily free quota**.

---

## 5. What happens when VULMS gives a 24-hour "Grace Day"?

- Virtual University often automatically extends assignment deadlines by 24 hours.
- When you open VULMS during the grace period, the extension detects that the `end_date` has shifted forward (e.g., from Nov 9 to Nov 10).
- The Google Sheet updates the `end_date` and marks the activity as `pending_extended`.
- On Nov 10 at 12:00 PM noon, you will receive a revised reminder with the subject:
  `🚨 [EXTENDED DEADLINE] VULMS Deadline Alert: [CS101] Assignment 1 Due Today`.

---

## 6. What if I install the extension midway through the semester?

- During the first sync, the system will encounter older assignments from past weeks.
- The ingestion filter compares each activity's `end_date` against current PKT time.
- Any activity whose deadline has already passed is automatically marked `status = "overdue"` and `reminder_status = "skipped_past_deadline"`.
- **You will never be spammed with alerts for past activities.**

---

## 7. How to force a manual synchronization?

1. Navigate to your VULMS Dashboard or Course page in Chrome.
2. Click the **VULMS Tracker** extension icon.
3. Click the **⚡ Sync Now** button.
4. A green toast will appear on your VULMS screen confirming the number of activities updated in your Google Sheet.
