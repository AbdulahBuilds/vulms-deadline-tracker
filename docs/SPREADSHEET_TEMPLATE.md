# 📊 Google Sheets Database Template & Schema Reference

When you activate the **VULMS Smart Deadline Tracker**, the backend script automatically creates a tab named **`Activities`** and formats the header row.

This document details the exact schema, constraints, and optional conditional formatting rules to turn your Google Sheet into a visual dashboard.

---

## 🗂️ Column Schema Definition

| Col # | Column Letter | Field Name | Data Type | Description / Constraints |
|:---:|:---:|:---|:---|:---|
| 1 | **A** | `student_id` | String | e.g. `bc210401234` |
| 2 | **B** | `activity_key` | String | Deterministic composite hash (e.g. `bc210401234_a1b2c3d4`) |
| 3 | **C** | `vulms_activity_id` | String | VULMS LMS Activity ID if found in submission link |
| 4 | **D** | `course_code` | String | Standardized course code (e.g. `CS101`, `MTH101`) |
| 5 | **E** | `course_name` | String | Full course title (e.g. `Introduction to Computing`) |
| 6 | **F** | `activity_title` | String | Exact title (e.g. `Assignment No. 1`) |
| 7 | **G** | `activity_type` | String | `Assignment` \| `Quiz` \| `GDB` \| `Practical` \| `Project` |
| 8 | **H** | `start_date` | Date (`YYYY-MM-DD`) | Opening date |
| 9 | **I** | `end_date` | Date (`YYYY-MM-DD`) | Deadline date |
| 10 | **J** | `activity_url` | String | Direct VULMS portal submission link |
| 11 | **K** | `status` | String | `active` \| `overdue` \| `cancelled` |
| 12 | **L** | `reminder_datetime` | DateTime | Target timestamp (`YYYY-MM-DD 12:00:00`) |
| 13 | **M** | `reminder_status` | String | `pending` \| `sent` \| `pending_extended` \| `skipped_past_deadline` |
| 14 | **N** | `reminder_sent_at` | DateTime | Timestamp when email was successfully sent |
| 15 | **O** | `created_at` | DateTime | Initial record insertion time |
| 16 | **P** | `updated_at` | DateTime | Last modification time (e.g. deadline shift) |
| 17 | **Q** | `last_synced_at` | DateTime | Last time seen in active VULMS session |

---

## 🎨 Recommended Conditional Formatting Rules

To make your Google Sheet visually dynamic and easy to monitor:

1. Select range `A2:Q1000`.
2. Click **Format** &gt; **Conditional formatting**.
3. Add the following rules:

### Rule 1: Pending Noon Alerts (Glowing Cyan)
- **Format cells if**: Custom formula is
- **Formula**: `=$M2="pending"`
- **Formatting Style**: Fill `#e0f2fe` (Soft Cyan), Text `#0369a1`

### Rule 2: Extended Deadline Alerts (Amber Warning)
- **Format cells if**: Custom formula is
- **Formula**: `=$M2="pending_extended"`
- **Formatting Style**: Fill `#fef3c7` (Soft Amber), Text `#b45309`

### Rule 3: Reminders Successfully Sent (Emerald Green)
- **Format cells if**: Custom formula is
- **Formula**: `=$M2="sent"`
- **Formatting Style**: Fill `#dcfce7` (Soft Emerald), Text `#15803d`

### Rule 4: Overdue / Past Deadlines (Slate Gray)
- **Format cells if**: Custom formula is
- **Formula**: `=$K2="overdue"`
- **Formatting Style**: Fill `#f1f5f9` (Soft Slate), Text `#94a3b8`

---

## 📈 Helpful Dashboard KPI Formulas

If you wish to create a "Summary" tab in your Google Sheet, paste these formulas:

| KPI Metric | Formula |
|:---|:---|
| **Total Tracked Activities** | `=COUNTA(Activities!A2:A)` |
| **Active Tasks Pending** | `=COUNTIF(Activities!K2:K, "active")` |
| **Pending Noon Alerts** | `=COUNTIF(Activities!M2:M, "pending") + COUNTIF(Activities!M2:M, "pending_extended")` |
| **Alerts Delivered** | `=COUNTIF(Activities!M2:M, "sent")` |
| **Next Due Date** | `=MINIFS(Activities!I2:I, Activities!K2:K, "active", Activities!I2:I, ">="&TEXT(TODAY(),"yyyy-mm-dd"))` |
