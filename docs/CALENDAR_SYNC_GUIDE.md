# 📅 VULMS Deadline Calendar Sync Guide

Welcome! You can now synchronize your Virtual University assignments, quizzes, and GDB deadlines with your digital calendar of choice: **Google Calendar**, **Apple Calendar (iPhone/Mac)**, or **Microsoft Outlook**.

---

## 🌟 Choose Your Sync Method

You have two completely automated, zero-download options to sync your deadlines:

| Method | Best For | How It Works |
|:---|:---|:---|
| **1. Google Calendar Auto-Sync** | Android phones, Google Calendar app, web calendar | Server-side sync directly inside your Google account via Google Apps Script. Creates a dedicated `"🎓 VULMS Deadlines"` sub-calendar. |
| **2. Live iCal / WebCal Subscription** | iPhone / iPad (Apple Calendar), Mac, Outlook | Live calendar feed URL. Subscribes once; automatically updates in the background. |

---

## ⚡ Option 1: Automatic Google Calendar Sync

When deadlines are synchronized from VULMS to your Google Sheet, Google Apps Script automatically creates and updates events in a dedicated Google Calendar named **`🎓 VULMS Deadlines`**.

### How It Works:
1. **Dedicated Calendar**: Keeps your university deadlines separate from personal events so you can toggle it on/off anytime in your Google Calendar app.
2. **Event Timing**: Each deadline is placed as an All-Day event on its due date.
3. **Automated Reminders**: Includes a native notification alert on the morning of the deadline day.
4. **Color Coding**:
   - 🔵 **Assignments**: Cyan / Blue
   - 🟠 **Quizzes**: Orange
   - 🟣 **GDBs**: Purple
5. **Direct Submission Links**: Every event contains the direct submission URL to VULMS and the course name.

### Manual Trigger:
- In your Google Sheet: Click **🚀 VULMS Tracker > 8. 📅 Sync All to Google Calendar**.
- In the Chrome Extension popup: Click **Sync Google Calendar**.

---

## 🍏 Option 2: Live iCal Subscription (iPhone, Mac & Outlook)

You can subscribe to your deadlines so they appear natively inside Apple Calendar on iOS, macOS, or Microsoft Outlook.

### Step 1: Get Your Subscription Feed URL
- In your Google Sheet: Click **🚀 VULMS Tracker > 9. 🔗 Get iCal / Apple Calendar Feed URL**.
- Or take your Web App URL and append `?feed=ical`:
  ```
  https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?feed=ical
  ```

### Step 2: Subscribe on iPhone / iPad:
1. Open **Settings** on your iPhone.
2. Scroll down and tap **Calendar** > **Calendar Accounts** (or **Accounts**).
3. Tap **Add Account** > **Other**.
4. Tap **Add Subscribed Calendar**.
5. Paste your subscription URL and tap **Next**.
6. Set the description to **VULMS Deadlines** and tap **Save**.
7. Done! Your iPhone will automatically fetch and show all upcoming deadlines with 12:00 PM notifications.

### Step 3: Subscribe on Mac (Apple Calendar):
1. Open the **Calendar** app on macOS.
2. In the top menu bar, click **File** > **New Calendar Subscription...**.
3. Paste the URL and click **Subscribe**.
4. Set *Auto-refresh* to **Every hour** or **Every day** and click **OK**.

### Step 4: Subscribe in Microsoft Outlook:
1. Open **Outlook Calendar** on web or desktop.
2. Click **Add Calendar** > **Subscribe from web** (or *From Internet*).
3. Paste the URL, choose a calendar icon and name (**VULMS Deadlines**), and click **Import**.

---

## 🎯 Individual Deadline Quick-Add

Looking at the upcoming deadline spotlight in the extension popup?
- Simply click **📅 Add to Cal** right on the spotlight card to open Google Calendar with the title, dates, and link pre-filled. Click **Save** and you're done!

