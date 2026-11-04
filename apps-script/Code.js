  /**
   * VULMS Smart Deadline Tracker — Google Apps Script Backend & Scheduler
   * 
   * Handles:
   * 1. Web App Endpoint (doPost) with text/plain JSON parsing (no CORS preflight rejection).
   * 2. Atomic concurrency lock via LockService.
   * 3. Database upsert logic with deterministic composite activity keys.
   * 4. Ingestion-time filtering for overdue activities.
   * 5. Grace period / extended deadline detection (pending_extended).
   * 6. Cloud time-driven hourly trigger targeting 12:00 PM PKT delivery.
   * 7. Beautiful HTML reminder emails dispatched via GmailApp.
   * 8. 1-Click setup menu for fellow students.
   */

  // Global Config
  var CONFIG = {
    TIMEZONE: 'Asia/Karachi',
    SHEET_NAME: 'Activities',
    TARGET_ALERT_HOUR: 12, // 12:00 PM noon PKT
    EVENING_ALERT_HOUR: 22, // 10:00 PM PKT
    APP_TITLE: 'VULMS Smart Deadline Tracker'
  };

  /**
   * Safe Date Formatter: extracts YYYY-MM-DD cleanly without timezone conversion jitter
   */
  function formatCellDate(val) {
    if (!val) return '';
    if (typeof val === 'string') {
      var str = val.trim();
      var match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (match) {
        return match[1] + '-' + match[2] + '-' + match[3];
      }
    }
    if (val instanceof Date) {
      return Utilities.formatDate(val, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    }
    try {
      return Utilities.formatDate(new Date(val), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    } catch (e) {
      return String(val);
    }
  }

  /**
   * Custom UI Menu added automatically when opening the Google Sheet
   */
  function onOpen() {
    SpreadsheetApp.getUi()
      .createMenu('🚀 VULMS Tracker')
      .addItem('1. 🧪 Test Email: Tasks Due Today', 'sendTestEmailForTodayFromMenu')
      .addItem('2. 📧 Test Email: Tasks Due Tomorrow', 'sendTestEmailForTomorrowFromMenu')
      .addItem('3. ⚡ Run Daily Reminder Check Now', 'checkAndSendRemindersFromMenu')
      .addSeparator()
      .addItem('4. 📅 Sync All to Google Calendar', 'syncAllActivitiesFromMenu')
      .addItem('5. 🗑️ Clean Submitted & Old Events from Calendar', 'purgeSubmittedAndOrphanCalendarEvents')
      .addSeparator()
      .addItem('6. 🛠️ 1-Click Clean Sheet & Fix Statuses', 'oneClickRepairAndCleanSheet')
      .addItem('7. ✉️ Set / Update Alert Email Address', 'promptAndUpdateStudentEmail')
      .addItem('8. 📊 View System Status', 'viewSystemStatus')
      .addItem('9. ⏰ Activate Automated Daily Cloud Schedulers', 'setupHourlyTrigger')
      .addToUi();
  }

  /**
   * 1-Click Master Clean & Self-Healing Tool:
   * 1. Purges duplicate rows and cleans sheet formatting.
   * 2. Self-heals: restores uncompleted tasks mistakenly marked as 'submitted' back to 'active' & 'pending'.
   * 3. Purges all old orphan events and submitted tasks from Google Calendar.
   * 4. Resyncs active deadlines with All-Day banner + 10:00 PM alarms.
   */
  function oneClickRepairAndCleanSheet() {
    var sheet = getOrCreateActivitiesSheet();
    var ui = SpreadsheetApp.getUi();

    // 1. Deduplicate Sheet
    var dedupRes = deduplicateSheet(sheet);

    // 2. Fix mistaken submitted statuses
    var data = sheet.getDataRange().getValues();
    var todayPkt = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    var fixedStatusCount = 0;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var status = String(row[10] || '').trim().toLowerCase();
      var rawEndDate = row[8];
      if (!rawEndDate) continue;
      var endDate = formatCellDate(rawEndDate);
      var submittedAt = String(row[23] || '').trim(); // column X

      if (status === 'submitted' && endDate >= todayPkt && !submittedAt) {
        sheet.getRange(i + 1, 11).setValue('active');
        sheet.getRange(i + 1, 12).setValue(endDate + ' 22:00:00');
        sheet.getRange(i + 1, 13).setValue('pending');
        sheet.getRange(i + 1, 21).setValue(''); // force re-sync
        fixedStatusCount++;
      }
    }

    // 3. Purge old/submitted events from Google Calendar
    var calCleanRes = purgeSubmittedAndOrphanCalendarEventsCore();

    // 4. Fresh re-sync of all active deadlines to Google Calendar
    var calSyncRes = { created: 0, updated: 0 };
    try {
      calSyncRes = syncAllActivitiesToGoogleCalendar(null, true);
    } catch (e) {}

    ui.alert(
      '✨ 1-Click Clean & Repair Complete!',
      'Here is what was done:\n' +
      '• Duplicate rows removed: ' + dedupRes.removed + '\n' +
      '• Restored active deadlines: ' + fixedStatusCount + '\n' +
      '• Old/submitted calendar events purged: ' + calCleanRes.deleted + '\n' +
      '• Google Calendar active events synced: ' + (calSyncRes.created + calSyncRes.updated) + '\n\n' +
      'Your sheet and Google Calendar are now completely synchronized and clean!',
      ui.ButtonSet.OK
    );
  }

  /**
   * Menu action: Purges old orphan events and submitted tasks from Google Calendar
   */
  function purgeSubmittedAndOrphanCalendarEvents() {
    var ui = SpreadsheetApp.getUi();
    var res = purgeSubmittedAndOrphanCalendarEventsCore();

    try {
      ui.alert(
        '🗑️ Google Calendar Cleaned!',
        'Successfully removed ' + res.deleted + ' old / submitted event(s) from your Google Calendar!\n\n' +
        '📱 Next Step on your phone:\n' +
        '1. Open the Google Calendar app on your phone.\n' +
        '2. Tap the top-left menu (☰) and tap "Refresh" (or pull down the screen to refresh).\n' +
        'The submitted events for CS302, CS403, and CS403P will vanish immediately!',
        ui.ButtonSet.OK
      );
    } catch (e) {
      console.log('Cleaned ' + res.deleted + ' events from Google Calendar.');
    }
  }

  /**
   * Core logic: Scans Google Calendar and purges old/submitted events
   */
  function purgeSubmittedAndOrphanCalendarEventsCore() {
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();

    // Map of currently registered active calendar event IDs from Column T
    var activeEventIds = {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var status = String(row[10] || '').trim().toLowerCase();
      var calIdStr = String(row[19] || '').trim();

      // Only preserve event IDs of ACTIVE, UNCOMPLETED activities
      if (calIdStr && status === 'active') {
        var parts = calIdStr.split('|');
        for (var p = 0; p < parts.length; p++) {
          var id = parts[p].trim();
          if (id) activeEventIds[id] = true;
        }
      }
    }

    var calendarsToCheck = [];
    try {
      var vulmsCal = getOrCreateVulmsCalendar();
      if (vulmsCal) calendarsToCheck.push(vulmsCal);
    } catch (e) {}
    try {
      var defaultCal = CalendarApp.getDefaultCalendar();
      if (defaultCal) {
        var isDuplicate = false;
        for (var k = 0; k < calendarsToCheck.length; k++) {
          if (calendarsToCheck[k].getId() === defaultCal.getId()) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) calendarsToCheck.push(defaultCal);
      }
    } catch (e) {}

    var now = new Date();
    // Scan from 14 days ago to 60 days ahead
    var startTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    var endTime = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    var deletedCount = 0;

    for (var c = 0; c < calendarsToCheck.length; c++) {
      var cal = calendarsToCheck[c];
      var events = cal.getEvents(startTime, endTime);

      for (var e = 0; e < events.length; e++) {
        var ev = events[e];
        var title = ev.getTitle();
        var evId = ev.getId();

        // Check if event is a VULMS deadline event
        var isVulmsEvent = (
          /^(\u23F0\s*)?\[[A-Z]{2,4}\d{3}[A-Z]?\]/i.test(title) ||
          /\[(CS|MTH|ENG|PHY|ISL|PAK|MGT|ECO|EDU|SOC|STA|MCM|BIO|BT|CHE|ZOO)\d+/i.test(title) ||
          (ev.getDescription() && ev.getDescription().includes('VULMS Smart Deadline Tracker'))
        );

        if (!isVulmsEvent) continue;

        // If this event is registered as an active deadline in the sheet, keep it!
        if (activeEventIds[evId]) {
          continue;
        }

        // Otherwise, it is an old orphan event or belongs to a submitted task -> delete it!
        try {
          ev.deleteEvent();
          deletedCount++;
        } catch (delErr) {
          console.warn('[Calendar Clean] Could not delete event:', title, delErr);
        }
      }
    }

    return { deleted: deletedCount };
  }

  /**
   * Backwards compatibility aliases
   */
  function resetMistakenSubmittedStatuses() {
    oneClickRepairAndCleanSheet();
  }
  function cleanDuplicateRowsFromMenu() {
    oneClickRepairAndCleanSheet();
  }

  /**
   * Web App Entry Point: POST
   * Accepts text/plain;charset=utf-8 to bypass CORS OPTIONS preflight and follows 302 redirects.
   */
  function doPost(e) {
    var lock = LockService.getScriptLock();
    var hasLock = false;
    try {
      // Try to acquire lock for up to 25 seconds without throwing fatal unhandled exception
      hasLock = lock.tryLock(25000);
      if (!hasLock) {
        return jsonResponse({
          status: 'busy',
          message: 'Server lock busy: another sync is currently running. Request skipped safely.'
        });
      }

      if (!e || !e.postData || !e.postData.contents) {
        return jsonResponse({ status: 'error', message: 'Empty POST body received' });
      }

      var payload = JSON.parse(e.postData.contents);
      var action = payload.action || 'sync_activities';

      // Verify optional secret token if set in Script Properties
      var configuredToken = PropertiesService.getScriptProperties().getProperty('SECRET_TOKEN');
      if (configuredToken && payload.secretToken !== configuredToken) {
        return jsonResponse({ status: 'error', message: 'Unauthorized: Invalid secret token' });
      }

      if (action === 'ping') {
        var pktNow = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
        return jsonResponse({
          status: 'success',
          message: 'VULMS Tracker Web App active and ready.',
          pktTime: pktNow
        });
      }

      if (action === 'send_test_email') {
        var recipient = (payload.studentEmail && payload.studentEmail.includes('@')) ?
          payload.studentEmail :
          (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail());
        sendTestNotificationEmail(recipient, payload.studentName || 'VU Student');
        return jsonResponse({
          status: 'success',
          message: 'Test email successfully sent to ' + recipient
        });
      }

      if (action === 'register_student') {
        var sheet = getOrCreateActivitiesSheet();
        var updatedCount = 0;
        if (payload.studentEmail || payload.studentName) {
          var allRows = sheet.getDataRange().getValues();
          for (var r = 1; r < allRows.length; r++) {
            if (!payload.studentId || String(allRows[r][0]).toLowerCase() === String(payload.studentId).toLowerCase()) {
              if (payload.studentEmail) sheet.getRange(r + 1, 19).setValue(payload.studentEmail);
              if (payload.studentName) sheet.getRange(r + 1, 18).setValue(payload.studentName);
              updatedCount++;
            }
          }
        }
        return jsonResponse({
          status: 'success',
          message: 'Student ' + (payload.studentId || '') + ' registered. Updated ' + updatedCount + ' existing row(s).',
          studentEmail: payload.studentEmail
        });
      }

      if (action === 'sync_activities') {
        var result = processSyncPayload(payload);
        return jsonResponse(result);
      }

      if (action === 'sync_calendar') {
        var calResult = syncAllActivitiesToGoogleCalendar(payload.studentId, true);
        return jsonResponse(calResult);
      }

      if (action === 'mark_submitted') {
        var markResult = markActivitySubmitted(payload.activityKey, payload.studentId);
        return jsonResponse(markResult);
      }

      return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });

    } catch (err) {
      console.error('Error in doPost:', err);
      return jsonResponse({
        status: 'error',
        message: err.toString()
      });
    } finally {
      if (hasLock) {
        try {
          lock.releaseLock();
        } catch (e) {}
      }
    }
  }

  /**
   * Web App Entry Point: GET (For browser status check)
   */
  function doGet(e) {
    if (e && e.parameter && (e.parameter.feed === 'ical' || e.parameter.action === 'ical')) {
      var studentId = e.parameter.studentId || '';
      var icsContent = generateIcsFeed(studentId);
      return ContentService.createTextOutput(icsContent)
        .setMimeType(ContentService.MimeType.ICAL);
    }

    var pktNow = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var userEmail = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    return ContentService.createTextOutput(
      'VULMS Smart Deadline Tracker Web App is ACTIVE.\n' +
      'Current PKT Time: ' + pktNow + '\n' +
      'Connected User Account: ' + userEmail + '\n' +
      'All systems nominal.\n\n' +
      'To subscribe to your live deadline calendar, use:\n' +
      ScriptApp.getService().getUrl() + '?feed=ical'
    ).setMimeType(ContentService.MimeType.TEXT);
  }

  /**
   * Helper to return standard JSON Output
   */
  function jsonResponse(data) {
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  /**
   * Ensures database sheet exists with correct headers
   */
  function getOrCreateActivitiesSheet() {
    var ss = null;
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {}

    if (!ss) {
      var props = PropertiesService.getScriptProperties();
      var savedId = props.getProperty('SPREADSHEET_ID');
      if (savedId) {
        try { ss = SpreadsheetApp.openById(savedId); } catch (e) {}
      }
    }

    if (!ss) {
      try {
        var files = DriveApp.getFilesByName('VULMS Deadline Tracker');
        if (files.hasNext()) {
          ss = SpreadsheetApp.open(files.next());
        }
      } catch (e) {}
    }

    if (!ss) {
      try {
        ss = SpreadsheetApp.create('VULMS Deadline Tracker');
        PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
      } catch (e) {
        throw new Error('Could not access Google Sheet. Please run script from Extensions > Apps Script inside your sheet.');
      }
    }

    if (ss) {
      try {
        ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
      } catch (tzErr) {}
    }

    var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

    var headers = [
      'student_id',         // A (1)
      'activity_key',       // B (2)
      'vulms_activity_id',  // C (3)
      'course_code',        // D (4)
      'course_name',        // E (5)
      'activity_title',     // F (6)
      'activity_type',      // G (7)
      'start_date',         // H (8)
      'end_date',           // I (9)
      'activity_url',       // J (10)
      'status',             // K (11) - active | overdue | cancelled
      'reminder_datetime',  // L (12) - YYYY-MM-DD 22:00:00 (10:00 PM PKT)
      'reminder_status',    // M (13) - pending | sent | skipped_past_deadline | pending_extended
      'reminder_sent_at',   // N (14)
      'created_at',         // O (15)
      'updated_at',         // P (16)
      'last_synced_at',     // Q (17)
      'student_name',       // R (18)
      'student_email',      // S (19)
      'calendar_event_id',  // T (20)
      'calendar_synced_at', // U (21)
      'total_marks',        // V (22)
      'lesson_topic',       // W (23)
      'submitted_at'        // X (24)
    ];

    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEET_NAME);
      sheet.appendRow(headers);

      // Format header styling
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setBackground('#1e293b'); // slate-800
      headerRange.setFontColor('#ffffff');
      headerRange.setFontWeight('bold');
      sheet.setFrozenRows(1);
    } else {
      // If empty sheet, append headers
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(headers);
      } else if (sheet.getLastColumn() < headers.length) {
        // Auto-migrate schema: append missing columns (calendar_event_id, calendar_synced_at)
        for (var h = sheet.getLastColumn(); h < headers.length; h++) {
          sheet.getRange(1, h + 1).setValue(headers[h])
            .setBackground('#1e293b')
            .setFontColor('#ffffff')
            .setFontWeight('bold');
        }
      }
    }

    return sheet;
  }

  /**
   * Process synchronized activities payload with deterministic upsert logic
   */
  function processSyncPayload(payload) {
    var sheet = getOrCreateActivitiesSheet();
    var activities = payload.activities || [];
    var studentId = payload.studentId || 'unassigned';
    var now = new Date();
    var todayPkt = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    var currentTimestamp = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    var data = sheet.getDataRange().getValues();
    var existingMap = {}; // activity_key => { rowIndex (1-based), rowData }
    var existingFuzzyMap = {}; // studentId + '_' + courseCode + '_' + activityType + '_' + actNum => { rowIndex, rowData }

    function extractActivityNumber(title) {
      if (!title) return '';
      var m = String(title).match(/(?:assignment|quiz|gdb|task)\s*(?:no\.?|#)?\s*0*(\d+)/i);
      return m ? m[1] : '';
    }

    // Index existing activities (primary by activity_key, secondary by course + type + number)
    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][1]).trim();
      var rStudent = String(data[i][0]).trim().toLowerCase();
      var rCourse = String(data[i][3]).trim().toUpperCase();
      var rType = String(data[i][6]).trim().toLowerCase();
      var rTitle = String(data[i][5]).trim();
      var rNum = extractActivityNumber(rTitle);

      var rowInfo = {
        rowNum: i + 1,
        data: data[i]
      };

      if (key) {
        existingMap[key] = rowInfo;
      }
      if (rStudent && rCourse && rType && rNum) {
        var fKey = rStudent + '_' + rCourse + '_' + rType + '_' + rNum;
        existingFuzzyMap[fKey] = rowInfo;
      }
    }

    var inserted = 0;
    var updated = 0;
    var skipped = 0;

    for (var a = 0; a < activities.length; a++) {
      var item = activities[a];
      var actKey = String(item.activity_key).trim();
      var actCourse = String(item.course_code || '').trim().toUpperCase();
      var actType = String(item.activity_type || 'Activity').trim().toLowerCase();
      var actNum = extractActivityNumber(item.activity_title);
      var fKey = studentId.toLowerCase() + '_' + actCourse + '_' + actType + '_' + actNum;

      var endDate = item.end_date;
      var startDate = item.start_date || endDate;
      var reminderTargetTime = endDate + ' 22:00:00';

      // Sanity Guard: Ignore legacy false positives (e.g. percentages "60%", year 1960)
      if (!endDate || endDate < '2024-01-01' || /^\s*\d{1,3}\s*%\s*$/.test(item.activity_title || '')) {
        continue;
      }

      // Ingestion-Time Filtering: Late-Discovered Past Due Items (Section 8)
      var initialStatus = 'active';
      var initialReminderStatus = 'pending';

      if (endDate < todayPkt) {
        initialStatus = 'overdue';
        initialReminderStatus = 'skipped_past_deadline';
      }
      if (item.status === 'submitted' || item.is_submitted) {
        initialStatus = 'submitted';
        initialReminderStatus = 'completed';
      }

      // Primary index by activity_key; Secondary fallback by (studentId + course + type + number)
      var existing = existingMap[actKey] || (actNum ? existingFuzzyMap[fKey] : null);

      if (!existing) {
        // INSERT NEW ROW
        sheet.appendRow([
          studentId,
          actKey,
          item.vulms_activity_id || '',
          item.course_code || '',
          item.course_name || '',
          item.activity_title || '',
          item.activity_type || 'Activity',
          startDate,
          endDate,
          item.activity_url || '',
          initialStatus,
          reminderTargetTime,
          initialReminderStatus,
          '', // reminder_sent_at
          currentTimestamp, // created_at
          currentTimestamp, // updated_at
          currentTimestamp, // last_synced_at
          payload.studentName || item.student_name || 'Muhammad Abdullah',
          payload.studentEmail || item.student_email || (studentId.toLowerCase() === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : resolveRecipientEmail(payload.studentEmail, studentId)),
          '', // calendar_event_id
          '', // calendar_synced_at
          item.total_marks || '', // total_marks (V / 22)
          item.lesson_topic || '', // lesson_topic (W / 23)
          item.submitted_at || '' // submitted_at (X / 24)
        ]);
        inserted++;
      } else {
        // EXISTING RECORD: EVALUATE DELTAS
        var rowNum = existing.rowNum;
        var existingStatus = String(existing.data[10]).trim();
        var existingCalId = String(existing.data[19] || '').trim();

        // Self-healing: if Column B key was using older format, update to clean normalized key
        if (actKey && actKey !== String(existing.data[1]).trim()) {
          sheet.getRange(rowNum, 2).setValue(actKey);
        }

        // Keep student name and email synced on all existing rows
        if (payload.studentEmail && payload.studentEmail !== existing.data[18]) {
          sheet.getRange(rowNum, 19).setValue(payload.studentEmail);
        }
        if (payload.studentName && payload.studentName !== existing.data[17]) {
          sheet.getRange(rowNum, 18).setValue(payload.studentName);
        }

        // Sync metadata fields (total_marks, lesson_topic, submitted_at)
        if (item.total_marks && item.total_marks !== existing.data[21]) {
          sheet.getRange(rowNum, 22).setValue(item.total_marks);
        }
        if (item.lesson_topic && item.lesson_topic !== existing.data[22]) {
          sheet.getRange(rowNum, 23).setValue(item.lesson_topic);
        }
        if (item.submitted_at && item.submitted_at !== existing.data[23]) {
          sheet.getRange(rowNum, 24).setValue(item.submitted_at);
        }

        // 1. Check if activity was submitted/completed on VULMS
        var isSubmitted = (item.status === 'submitted' || item.is_submitted);
        if (isSubmitted) {
          if (item.submitted_at && item.submitted_at !== existing.data[23]) {
            sheet.getRange(rowNum, 24).setValue(item.submitted_at);
          }
          if (existingStatus !== 'submitted') {
            sheet.getRange(rowNum, 11).setValue('submitted'); // status
            sheet.getRange(rowNum, 13).setValue('completed'); // reminder_status
            sheet.getRange(rowNum, 16).setValue(currentTimestamp); // updated_at
            sheet.getRange(rowNum, 17).setValue(currentTimestamp); // last_synced_at

            // Automatically delete Google Calendar event so 10:00 PM alarm will not fire
            if (existingCalId) {
              try {
                var cal = getOrCreateVulmsCalendar();
                var parts = String(existingCalId).split('|');
                for (var p = 0; p < parts.length; p++) {
                  var id = parts[p].trim();
                  if (!id) continue;
                  var ev = cal.getEventById(id);
                  if (ev) ev.deleteEvent();
                }
                sheet.getRange(rowNum, 20).setValue(''); // calendar_event_id
                sheet.getRange(rowNum, 21).setValue(''); // calendar_synced_at
              } catch (calErr) {
                console.warn('[Sync] Could not delete submitted event from calendar:', calErr);
              }
            }
            updated++;
          } else {
            skipped++;
          }
          continue;
        } else {
          // Self-Healing: If VULMS reports that it is NOT submitted, but Sheet had previously marked it submitted
          // (e.g. from the legacy To-Do auto-reconciliation bug), restore it back to active/pending!
          if (existingStatus === 'submitted') {
            var restoredStatus = (endDate >= todayPkt) ? 'active' : 'overdue';
            var restoredRemStatus = (endDate >= todayPkt) ? 'pending' : 'skipped_past_deadline';
            sheet.getRange(rowNum, 11).setValue(restoredStatus); // status
            sheet.getRange(rowNum, 12).setValue(endDate + ' 22:00:00'); // reminder_datetime (10:00 PM PKT)
            sheet.getRange(rowNum, 13).setValue(restoredRemStatus); // reminder_status
            sheet.getRange(rowNum, 16).setValue(currentTimestamp); // updated_at
            sheet.getRange(rowNum, 17).setValue(currentTimestamp); // last_synced_at
            sheet.getRange(rowNum, 21).setValue(''); // Force re-sync to Google Calendar
            existingStatus = restoredStatus;
            updated++;
          }
        }

        var existingEndDate = formatCellDate(existing.data[8]);
        var existingReminderStatus = String(existing.data[12]).trim();

        var hasDeadlineChanged = (endDate !== existingEndDate);
        var hasUrlChanged = (item.activity_url && item.activity_url !== existing.data[9]);

        if (hasDeadlineChanged) {
          // Deadline shift / Grace Period Extension handling (Section 7)
          var newReminderStatus = existingReminderStatus;

          if (endDate >= todayPkt) {
            if (existingReminderStatus === 'sent') {
              // Extended after original alert was sent
              newReminderStatus = 'pending_extended';
            } else if (existingReminderStatus === 'skipped_past_deadline' || existingReminderStatus === 'pending') {
              newReminderStatus = 'pending';
            }
            sheet.getRange(rowNum, 11).setValue('active'); // status
          } else {
            newReminderStatus = 'skipped_past_deadline';
            sheet.getRange(rowNum, 11).setValue('overdue');
          }

          sheet.getRange(rowNum, 9).setValue(endDate); // end_date
          sheet.getRange(rowNum, 12).setValue(reminderTargetTime); // reminder_datetime
          sheet.getRange(rowNum, 13).setValue(newReminderStatus); // reminder_status
          sheet.getRange(rowNum, 16).setValue(currentTimestamp); // updated_at
          sheet.getRange(rowNum, 17).setValue(currentTimestamp); // last_synced_at
          sheet.getRange(rowNum, 21).setValue(''); // Clear calendar_synced_at to refresh calendar event

          if (hasUrlChanged) {
            sheet.getRange(rowNum, 10).setValue(item.activity_url);
          }

          updated++;
        } else if (hasUrlChanged) {
          sheet.getRange(rowNum, 10).setValue(item.activity_url);
          sheet.getRange(rowNum, 16).setValue(currentTimestamp);
          sheet.getRange(rowNum, 17).setValue(currentTimestamp);
          updated++;
        } else {
          // Unchanged row: skip without slow cell writes
          skipped++;
        }
      }
    }

    // ----------------------------------------------------
    // STEP 2: Reconcile Missing Tasks & Deduplicate Sheet
    // In VULMS, completing an activity removes it from the To-Do calendar!
    // ----------------------------------------------------
    if (activities.length > 0) {
      var incomingKeys = {};
      var incomingFuzzyKeys = {};

      for (var a = 0; a < activities.length; a++) {
        var it = activities[a];
        var k = String(it.activity_key || '').trim();
        if (k) incomingKeys[k] = true;
        var c = String(it.course_code || '').trim().toUpperCase();
        var t = String(it.activity_type || 'Activity').trim().toLowerCase();
        var n = extractActivityNumber(it.activity_title);
        var normT = String(it.activity_title || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        var actIdent = n ? ('num_' + n) : ('title_' + normT);
        if (c && t) {
          incomingFuzzyKeys[c + '_' + t + '_' + actIdent] = true;
        }
      }

      var postSyncData = sheet.getDataRange().getValues();
      var rowsToDelete = [];
      var seenIdentityMap = {}; // identityKey => { rowNum, studentId, isSubmitted, calId }

      for (var r = 1; r < postSyncData.length; r++) {
        var row = postSyncData[r];
        var rRowNum = r + 1;
        var rStudent = String(row[0] || '').trim().toLowerCase();
        var rKey = String(row[1] || '').trim();
        var rCourse = String(row[3] || '').trim().toUpperCase();
        var rType = String(row[6] || '').trim().toLowerCase();
        var rTitle = String(row[5] || '').trim();
        var rNum = extractActivityNumber(rTitle);
        var rNormT = rTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
        var rActIdent = rNum ? ('num_' + rNum) : ('title_' + rNormT);
        var rEndDate = row[8] ? formatCellDate(row[8]) : '';
        var rStatus = String(row[10] || '').trim();
        var rCalId = String(row[19] || '').trim();

        var isTargetStudent = (!payload.studentId || rStudent === payload.studentId.toLowerCase() || rStudent === 'unassigned');
        if (!isTargetStudent) continue;

        var identityKey = rCourse + '_' + rType + '_' + rActIdent;

        // DEDUPLICATION: If duplicate row exists for identical course + type + number/title
        if (rCourse && rType) {
          if (seenIdentityMap[identityKey]) {
            var existingPrimary = seenIdentityMap[identityKey];
            var primaryRow = existingPrimary.rowNum;

            if (rStatus === 'submitted') {
              sheet.getRange(primaryRow, 11).setValue('submitted');
              sheet.getRange(primaryRow, 13).setValue('completed');
              existingPrimary.isSubmitted = true;
            }

            // Promote actual studentId if primary row had 'unassigned'
            if ((!existingPrimary.studentId || existingPrimary.studentId === 'unassigned') && rStudent && rStudent !== 'unassigned') {
              sheet.getRange(primaryRow, 1).setValue(rStudent);
              existingPrimary.studentId = rStudent;
            }
            if (!existingPrimary.calId && rCalId) {
              sheet.getRange(primaryRow, 20).setValue(rCalId);
              existingPrimary.calId = rCalId;
            }

            rowsToDelete.push(rRowNum);
            continue;
          } else {
            seenIdentityMap[identityKey] = {
              rowNum: rRowNum,
              studentId: rStudent,
              isSubmitted: (rStatus === 'submitted'),
              calId: rCalId
            };
          }
        }
      }

      // Delete duplicate rows from bottom to top so row indices remain valid
      if (rowsToDelete.length > 0) {
        for (var d = rowsToDelete.length - 1; d >= 0; d--) {
          sheet.deleteRow(rowsToDelete[d]);
        }
        console.log('[Sync] Cleaned up ' + rowsToDelete.length + ' duplicate row(s).');
      }
    }

    // Count active pending reminders
    var updatedData = sheet.getDataRange().getValues();
    var pendingCount = 0;
    for (var r = 1; r < updatedData.length; r++) {
      var remStatus = String(updatedData[r][12]).trim();
      if (remStatus === 'pending' || remStatus === 'pending_extended') {
        pendingCount++;
      }
    }

    // Auto-sync active deadlines to Google Calendar
    var calSyncResult = { synced: 0, errors: 0 };
    try {
      calSyncResult = syncAllActivitiesToGoogleCalendar(studentId);
    } catch (calErr) {
      console.warn('[Apps Script] Auto calendar sync warning:', calErr.message || calErr);
    }

    return {
      status: 'success',
      inserted: inserted,
      updated: updated,
      skipped: skipped,
      totalTracked: updatedData.length - 1,
      pendingReminders: pendingCount,
      calendarSync: calSyncResult
    };
  }

  /**
   * Evaluates and dispatches reminder emails for activities due today.
   * Can be invoked by the hourly cloud trigger or manually from the sheet menu.
   *
   * @param {boolean} [isManual=false] - When true, bypasses the hour gatekeeper and reports results to UI
   */
  function checkAndSendReminders(isManual) {
    return checkAndSendRemindersCore(isManual === true);
  }

  /**
   * Menu Handler: Checks for pending activities due today and sends email immediately
   */
  function checkAndSendRemindersFromMenu() {
    var ui = SpreadsheetApp.getUi();
    try {
      var res = checkAndSendRemindersCore(true);
      if (res.dispatched > 0) {
        ui.alert(
          '📧 Reminders Dispatched!',
          'Sent reminder email for ' + res.tasksFound + ' task(s) due today!\n\n' +
          'Check your inbox (' + (res.recipients.join(', ') || 'registered email') + ').',
          ui.ButtonSet.OK
        );
      } else {
        ui.alert(
          'ℹ️ No Pending Reminders Due Today',
          'Checked all activities in the sheet.\n\n' +
          'Either there are no tasks due today, or all tasks due today have already been marked "sent" or "submitted".\n\n' +
          '(Tip: If tasks were mistakenly marked "submitted", run Menu Item 12: "Fix Mistaken Submitted Statuses" first!)',
          ui.ButtonSet.OK
        );
      }
    } catch (err) {
      ui.alert('Error', 'Failed to dispatch reminders: ' + err.message, ui.ButtonSet.OK);
    }
  }

  /**
   * Core reminder engine
   */
  function checkAndSendRemindersCore(isManual) {
    var now = new Date();
    var pktString = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
    var currentPktDate = pktString.substring(0, 10); // 'YYYY-MM-DD'
    var currentHour = parseInt(pktString.substring(11, 13), 10); // 0-23

    console.log('[VULMS Scheduler] Trigger fired. Current PKT: ' + pktString + ', Hour: ' + currentHour + ', Manual: ' + !!isManual);

    // Exact 12:00 PM PKT Gatekeeper: Do not send before 12:00 PM noon PKT (unless manually tested from menu)
    if (!isManual && currentHour < CONFIG.TARGET_ALERT_HOUR) {
      console.log('[VULMS Scheduler] Current hour ' + currentHour + ' < 12:00 PM PKT. Gatekeeper holds dispatch.');
      return { status: 'held', dispatched: 0, tasksFound: 0, recipients: [] };
    }

    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { status: 'empty', dispatched: 0, tasksFound: 0, recipients: [] };

    // Group pending tasks due today by student recipient
    var tasksByRecipient = {};
    var totalTasksFound = 0;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var endDateRaw = row[8];
      if (!endDateRaw) continue;

      var endDate = formatCellDate(endDateRaw);
      var reminderStatus = String(row[12]).trim();

      var reminderDateRaw = row[11]; // reminder_datetime
      var reminderMatches = false;
      if (reminderDateRaw) {
        var remDateStr = String(reminderDateRaw).trim();
        if (remDateStr.indexOf(currentPktDate) !== -1) {
          reminderMatches = true;
        }
      }

      // Trigger on exact end date OR if reminder_datetime matches today
      if ((reminderStatus === 'pending' || reminderStatus === 'pending_extended') && (endDate === currentPktDate || reminderMatches)) {
        var studentId = String(row[0] || 'VU Student').trim();
        var studentName = String(row[17] || studentId).trim();
        var rawEmail = String(row[18] || '').trim();
        var targetRecipient = resolveRecipientEmail(rawEmail, studentId);

        if (!tasksByRecipient[targetRecipient]) {
          tasksByRecipient[targetRecipient] = {
            studentId: studentId,
            studentName: studentName,
            tasks: [],
            rowIndexes: []
          };
        }

        tasksByRecipient[targetRecipient].tasks.push({
          row: row,
          isExtended: (reminderStatus === 'pending_extended'),
          courseCode: row[3] || 'VU Course',
          courseName: row[4] || '',
          activityTitle: row[5] || 'Activity',
          activityType: row[6] || 'Assignment',
          endDate: endDate,
          activityUrl: row[9] || 'https://vulms.vu.edu.pk',
          totalMarks: row[21] || '',
          lessonTopic: row[22] || ''
        });
        tasksByRecipient[targetRecipient].rowIndexes.push(i + 1);
        totalTasksFound++;
      }
    }

    var emailsDispatched = 0;
    var recipientList = [];

    // Send one consolidated email per student recipient
    for (var recipient in tasksByRecipient) {
      if (!tasksByRecipient.hasOwnProperty(recipient)) continue;
      var group = tasksByRecipient[recipient];

      try {
        sendConsolidatedReminderEmail(recipient, group.studentName, group.studentId, group.tasks);

        // Mark all corresponding rows as sent
        var sentTimestamp = new Date();
        for (var k = 0; k < group.rowIndexes.length; k++) {
          var rowIndex = group.rowIndexes[k];
          sheet.getRange(rowIndex, 13).setValue('sent');
          sheet.getRange(rowIndex, 14).setValue(sentTimestamp);
        }

        emailsDispatched++;
        recipientList.push(recipient);
        console.log('[VULMS Scheduler] Sent reminder with ' + group.tasks.length + ' task(s) to ' + recipient);
      } catch (err) {
        console.error('[VULMS Scheduler] Failed to send email to ' + recipient + ':', err);
      }
    }

    console.log('[VULMS Scheduler] Reminder run finished. Emails dispatched: ' + emailsDispatched);
    return {
      status: 'success',
      dispatched: emailsDispatched,
      tasksFound: totalTasksFound,
      recipients: recipientList
    };
  }

  /**
   * Sends clean plain text reminder email (handles 1 task or multiple tasks in 1 single email)
   */
  function sendConsolidatedReminderEmail(recipient, studentName, studentId, tasks) {
    if (!tasks || tasks.length === 0) return;

    var subject;
    var lines = [];

    lines.push('Hello ' + studentName + ' (' + studentId + '),');
    lines.push('');

    if (tasks.length === 1) {
      var item = tasks[0];
      var prefix = item.isExtended ? '[EXTENDED DEADLINE] ' : '';
      subject = prefix + 'VULMS Deadline Alert: [' + item.courseCode + '] ' + item.activityTitle + ' Due Today';

      if (item.isExtended) {
        lines.push('⚠️ NOTE: The deadline for this activity was extended and is due today!');
      } else {
        lines.push('This is an automated reminder that your deadline is due today:');
      }
      lines.push('');
      lines.push('• Course: ' + item.courseCode + (item.courseName ? ' - ' + item.courseName : ''));
      lines.push('• Activity: ' + item.activityTitle + ' (' + item.activityType + ')');
      if (item.lessonTopic) {
        lines.push('• Topic / Lesson: ' + item.lessonTopic);
      }
      if (item.totalMarks) {
        lines.push('• Weightage: ' + item.totalMarks + ' Marks');
      }
      lines.push('• Deadline: ' + item.endDate + ' at 11:59 PM PKT');
      lines.push('• Link: ' + item.activityUrl);
    } else {
      subject = 'VULMS Deadline Alert: ' + tasks.length + ' Activities Due Today';
      lines.push('You have ' + tasks.length + ' deadlines due today (' + tasks[0].endDate + '):');
      lines.push('--------------------------------------------------');

      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        var tag = t.isExtended ? ' [EXTENDED]' : '';
        lines.push((i + 1) + '. [' + t.courseCode + '] ' + t.activityTitle + tag);
        lines.push('   • Course: ' + (t.courseName || t.courseCode));
        lines.push('   • Type: ' + t.activityType);
        if (t.lessonTopic) lines.push('   • Topic / Lesson: ' + t.lessonTopic);
        if (t.totalMarks) lines.push('   • Weightage: ' + t.totalMarks + ' Marks');
        lines.push('   • Deadline: 11:59 PM PKT');
        lines.push('   • Link: ' + t.activityUrl);
        lines.push('');
      }
      lines.push('--------------------------------------------------');
    }

    lines.push('');
    lines.push('Please ensure you complete and submit your work before 11:59 PM PKT to avoid late penalties.');
    lines.push('');
    lines.push('--');
    lines.push('VULMS Smart Deadline Tracker');

    GmailApp.sendEmail(recipient, subject, lines.join('\n'), {
      name: 'VULMS Smart Deadline Tracker'
    });
  }

  /**
   * 1-Click Trigger Setup: Programmatically installs the hourly trigger
   */
  function setupHourlyTrigger() {
    // Clear any existing triggers for checkAndSendReminders to avoid duplicates
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'checkAndSendReminders') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    // Create new hourly trigger
    ScriptApp.newTrigger('checkAndSendReminders')
      .timeBased()
      .everyHours(1)
      .create();

    // Initialize sheet if not yet created
    getOrCreateActivitiesSheet();

    var ui = SpreadsheetApp.getUi();
    ui.alert(
      '🚀 12:00 PM Scheduler Activated!',
      'The cloud scheduler is now running hourly in Google Cloud.\n\n' +
      'Every day at 12:00 PM PKT, it will scan your "Activities" sheet and dispatch an email reminder for any activity due that day.\n\n' +
      'This executes 100% in the cloud even when your computer is off.',
      ui.ButtonSet.OK
    );
  }

  /**
   * Menu action: Send test reminder email for all activities due TODAY
   */
  function sendTestEmailForTodayFromMenu() {
    var todayPkt = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    sendTestEmailForSpecificDate(todayPkt, 'Today');
  }

  /**
   * Menu action: Send test reminder email for all activities due TOMORROW
   */
  function sendTestEmailForTomorrowFromMenu() {
    var now = new Date();
    var tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    var tomorrowPkt = Utilities.formatDate(tomorrow, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    sendTestEmailForSpecificDate(tomorrowPkt, 'Tomorrow');
  }

  /**
   * Backwards compatibility alias
   */
  function sendTestEmailFromMenu() {
    sendTestEmailForTodayFromMenu();
  }

  /**
   * Dispatches a test reminder email for all activities due on a specific target date
   *
   * @param {string} targetDate - 'YYYY-MM-DD'
   * @param {string} label - e.g. "Today" or "Tomorrow"
   */
  function sendTestEmailForSpecificDate(targetDate, label) {
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    var ui = SpreadsheetApp.getUi();

    if (data.length <= 1) {
      ui.alert('No Data', 'Your Activities sheet is empty. Please sync your VULMS courses first.', ui.ButtonSet.OK);
      return;
    }

    var matchingTasks = [];
    var targetRecipient = '';
    var studentName = '';
    var studentId = '';

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rawEndDate = row[8];
      if (!rawEndDate) continue;

      var endDate = formatCellDate(rawEndDate);
      if (endDate === targetDate) {
        if (!studentId) studentId = String(row[0] || 'bc240424582').trim();
        if (!studentName) studentName = String(row[17] || 'Muhammad Abdullah').trim();
        if (!targetRecipient) {
          var rawEmail = String(row[18] || '').trim();
          targetRecipient = resolveRecipientEmail(rawEmail, studentId);
        }

        var isSubmitted = (String(row[10] || '').trim().toLowerCase() === 'submitted');

        matchingTasks.push({
          row: row,
          courseCode: row[3] || 'VU Course',
          courseName: row[4] || '',
          activityTitle: row[5] || 'Activity',
          activityType: row[6] || 'Assignment',
          endDate: endDate,
          activityUrl: row[9] || 'https://vulms.vu.edu.pk',
          totalMarks: row[21] || '',
          lessonTopic: row[22] || '',
          isSubmitted: isSubmitted,
          submittedAt: row[23] || ''
        });
      }
    }

    var activeSender = '';
    try {
      activeSender = (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    } catch (e) {}

    // Check if recipient is missing or mistakenly targeting the sender bot itself
    var isSelfSending = activeSender && targetRecipient.toLowerCase() === activeSender;

    if (!targetRecipient || isSelfSending) {
      var promptRes = ui.prompt(
        '✉️ Set Alert Destination Email',
        'Sender bot account: ' + activeSender + '\n\n' +
        'Please enter YOUR personal or student email where you want to receive alerts:\n' +
        '(e.g. your personal Gmail or official bc240424582mab@vu.edu.pk)',
        ui.ButtonSet.OK_CANCEL
      );

      if (promptRes.getSelectedButton() === ui.Button.OK) {
        var userInp = promptRes.getResponseText().trim();
        if (userInp && userInp.includes('@') && userInp.toLowerCase() !== activeSender) {
          targetRecipient = userInp;
          try {
            PropertiesService.getScriptProperties().setProperty('ALERT_EMAIL', targetRecipient);
          } catch (e) {}
          for (var r = 1; r < data.length; r++) {
            sheet.getRange(r + 1, 19).setValue(targetRecipient);
          }
        } else {
          ui.alert('Invalid Destination Email', 'Please enter a valid personal or student email different from the sender bot (' + activeSender + ').', ui.ButtonSet.OK);
          return;
        }
      } else {
        return;
      }
    }

    if (!studentName) studentName = 'Muhammad Abdullah';
    if (!studentId) studentId = 'bc240424582';

    if (matchingTasks.length === 0) {
      ui.alert(
        'ℹ️ No Tasks Found',
        'No activities found in your sheet with due date: ' + targetDate + ' (' + label + ').\n\n' +
        'Check column I (end_date) in your Activities sheet.',
        ui.ButtonSet.OK
      );
      return;
    }

    var subject = '[TEST] VULMS Deadline Alert: ' + matchingTasks.length + ' Activities Due ' + label + ' (' + targetDate + ')';
    var lines = [];

    lines.push('Hello ' + studentName + ' (' + studentId + '),');
    lines.push('');
    lines.push('This is a TEST reminder email for all activities due ' + label.toUpperCase() + ' (' + targetDate + '):');
    lines.push('==================================================');

    for (var t = 0; t < matchingTasks.length; t++) {
      var task = matchingTasks[t];
      var statusTag = task.isSubmitted ? ' [✅ SUBMITTED]' : ' [⏳ PENDING]';
      lines.push((t + 1) + '. [' + task.courseCode + '] ' + task.activityTitle + statusTag);
      lines.push('   • Course: ' + (task.courseName || task.courseCode));
      lines.push('   • Type: ' + task.activityType);
      if (task.lessonTopic) lines.push('   • Topic / Lesson: ' + task.lessonTopic);
      if (task.totalMarks) lines.push('   • Weightage: ' + task.totalMarks + ' Marks');
      lines.push('   • Deadline: ' + task.endDate + ' at 11:59 PM PKT');
      if (task.isSubmitted && task.submittedAt) {
        lines.push('   • Submitted On: ' + task.submittedAt);
      }
      lines.push('   • Submission Link: ' + task.activityUrl);
      lines.push('');
    }
    lines.push('==================================================');
    lines.push('');
    lines.push('Please ensure all pending activities are completed before 11:59 PM PKT to avoid late penalties.');
    lines.push('');
    lines.push('--');
    lines.push('VULMS Smart Deadline Tracker (Manual Test Dispatch)');

    try {
      GmailApp.sendEmail(targetRecipient, subject, lines.join('\n'), {
        name: 'VULMS Smart Deadline Tracker'
      });

      ui.alert(
        '📧 Test Email Sent!',
        'Successfully dispatched test email for ' + matchingTasks.length + ' activity/activities due ' + label + ' (' + targetDate + ')!\n\n' +
        'Sent to: ' + targetRecipient + '\n\n' +
        'Check your inbox or spam folder now.',
        ui.ButtonSet.OK
      );
    } catch (err) {
      ui.alert('Email Dispatch Error', 'Failed to send email:\n' + err.message, ui.ButtonSet.OK);
    }
  }

  /**
   * View System Status from Menu
   */
  function viewSystemStatus() {
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    var count = Math.max(0, data.length - 1);
    var pending = 0;
    var sent = 0;

    for (var i = 1; i < data.length; i++) {
      var s = String(data[i][12]).trim();
      if (s === 'pending' || s === 'pending_extended') pending++;
      if (s === 'sent') sent++;
    }

    var triggers = ScriptApp.getProjectTriggers();
    var hasTrigger = false;
    for (var t = 0; t < triggers.length; t++) {
      if (triggers[t].getHandlerFunction() === 'checkAndSendReminders') hasTrigger = true;
    }

    var pktNow = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var ui = SpreadsheetApp.getUi();
    ui.alert(
      '📊 VULMS Tracker System Status',
      '• Current PKT Time: ' + pktNow + '\n' +
      '• Total Activities: ' + count + '\n' +
      '• Pending Reminders: ' + pending + '\n' +
      '• Sent Reminders: ' + sent + '\n' +
      '• Hourly Cloud Trigger: ' + (hasTrigger ? 'ACTIVE ✅' : 'NOT INSTALLED ⚠️ (Run step 1 to activate)'),
      ui.ButtonSet.OK
    );
  }

  /**
   * Programmatic Acceptance Test Suite (Tests A through J)
   */
  function runSelfTest() {
    console.log('Running VULMS Tracker Self-Test Suite...');
    var sheet = getOrCreateActivitiesSheet();
    var mockStudent = 'bc_test_001';
    var testPayload = {
      action: 'sync_activities',
      studentId: mockStudent,
      activities: [
        {
          activity_key: mockStudent + '_test_cs101_assign1',
          course_code: 'CS101',
          course_name: 'Intro to Computing',
          activity_title: 'Test Assignment 1',
          activity_type: 'Assignment',
          start_date: '2026-11-01',
          end_date: '2026-11-10',
          activity_url: 'https://vulms.vu.edu.pk'
        }
      ]
    };

    // Test A: First-time extraction inserts 1 row
    var resA = processSyncPayload(testPayload);
    console.log('Test A (Insert):', resA.inserted === 1 ? 'PASS' : 'FAIL', resA);

    // Test B: Repeated extraction produces 0 duplicate rows
    var resB = processSyncPayload(testPayload);
    console.log('Test B (Deduplication):', (resB.inserted === 0 && resB.skipped === 1) ? 'PASS' : 'FAIL', resB);

    // Test D: Deadline extended updates row
    testPayload.activities[0].end_date = '2026-11-12';
    var resD = processSyncPayload(testPayload);
    console.log('Test D (Extension):', resD.updated === 1 ? 'PASS' : 'FAIL', resD);

    console.log('Self-Test complete.');
  }

  /**
   * Intelligently resolves alert recipient email:
   * 1. Prioritizes student personal email (e.g. Gmail) or official VU email with initials suffix.
   * 2. Prevents sending to the sender bot account itself (e.g. deadlinetracker0@gmail.com).
   * 3. Checks script property ALERT_EMAIL.
   * 4. Falls back to verified student profile (bc240424582mab@vu.edu.pk).
   */
  function resolveRecipientEmail(rowEmail, studentId) {
    var activeUserEmail = '';
    try {
      activeUserEmail = (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    } catch (e) {}

    var cleanEmail = String(rowEmail || '').trim();
    var isBareVuEmail = /^[a-zA-Z]{2}\d{7,9}@vu\.edu\.pk$/i.test(cleanEmail);
    var isSenderBot = activeUserEmail && (cleanEmail.toLowerCase() === activeUserEmail || cleanEmail.toLowerCase().includes('deadlinetracker'));

    // 1. Valid personal email or official VU email with initials suffix (NOT the sender bot)
    if (cleanEmail && cleanEmail.includes('@') && !isBareVuEmail && !isSenderBot) {
      return cleanEmail;
    }

    // 2. Saved alert destination in Script Properties
    try {
      var savedProp = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
      if (savedProp && savedProp.includes('@') && (!activeUserEmail || savedProp.toLowerCase() !== activeUserEmail)) {
        return savedProp;
      }
    } catch (e) {}

    // 3. Known student profile fallback (Muhammad Abdullah)
    if (String(studentId).toLowerCase() === 'bc240424582') {
      return 'bc240424582mab@vu.edu.pk';
    }

    // 4. Fallback to activeUserEmail ONLY if it's the personal account (not deadlinetracker bot)
    if (activeUserEmail && activeUserEmail.includes('@') && !activeUserEmail.includes('deadlinetracker')) {
      return activeUserEmail;
    }

    return (studentId ? (studentId + '@vu.edu.pk') : '') || 'bc240424582mab@vu.edu.pk';
  }

  /**
   * Menu action allowing student to view or update reminder email for all rows
   */
  function promptAndUpdateStudentEmail() {
    var sheet = getOrCreateActivitiesSheet();
    var activeSender = '';
    try {
      activeSender = (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase();
    } catch (e) {}

    var currentEmail = '';
    var data = sheet.getDataRange().getValues();
    if (data.length > 1 && data[1][18]) {
      var colEmail = String(data[1][18]).trim();
      if (colEmail && colEmail.toLowerCase() !== activeSender && !colEmail.toLowerCase().includes('deadlinetracker')) {
        currentEmail = colEmail;
      }
    }

    if (!currentEmail) {
      try {
        var savedProp = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
        if (savedProp && savedProp.toLowerCase() !== activeSender) currentEmail = savedProp;
      } catch (e) {}
    }

    if (!currentEmail) {
      currentEmail = 'bc240424582mab@vu.edu.pk';
    }

    var ui = SpreadsheetApp.getUi();
    var response = ui.prompt(
      '✉️ Set Alert Destination Email',
      'Sender Bot Account: ' + activeSender + '\n\n' +
      'Current Alert Destination: ' + currentEmail + '\n\n' +
      'Enter the personal or university email address where you want to receive deadline alerts:\n' +
      '(e.g. your personal Gmail or official bc...mab@vu.edu.pk)',
      ui.ButtonSet.OK_CANCEL
    );

    if (response.getSelectedButton() === ui.Button.OK) {
      var newEmail = response.getResponseText().trim();
      if (!newEmail || !newEmail.includes('@') || (activeSender && newEmail.toLowerCase() === activeSender)) {
        ui.alert('Invalid Email', 'Please enter a valid email address different from the sender bot account (' + activeSender + ').', ui.ButtonSet.OK);
        return;
      }

      try {
        PropertiesService.getScriptProperties().setProperty('ALERT_EMAIL', newEmail);
      } catch (e) {}

      var rowsUpdated = 0;
      for (var i = 1; i < data.length; i++) {
        sheet.getRange(i + 1, 19).setValue(newEmail);
        rowsUpdated++;
      }

      ui.alert(
        'Email Destination Updated!',
        'Successfully set alert destination to:\n' + newEmail + '\n\nUpdated ' + rowsUpdated + ' row(s) in your sheet.\n\nAll future reminders will be sent FROM ' + activeSender + ' TO ' + newEmail + '!',
        ui.ButtonSet.OK
      );
    }
  }

  // =========================================================================
  // 📅 CALENDAR SYNCHRONIZATION ENGINE (Google Calendar & RFC 5545 iCal Feed)
  // =========================================================================

  /**
   * Retrieves or creates a dedicated secondary calendar named '🎓 VULMS Deadlines'.
   * Keeping university deadlines in a dedicated calendar prevents cluttering personal schedules.
   */
  function getOrCreateVulmsCalendar() {
    var calName = '🎓 VULMS Deadlines';
    var cals = CalendarApp.getCalendarsByName(calName);
    if (cals && cals.length > 0) {
      return cals[0];
    }

    try {
      var newCal = CalendarApp.createCalendar(calName, {
        summary: 'Virtual University of Pakistan (VULMS) Assignments, Quizzes & GDB Deadlines',
        timeZone: CONFIG.TIMEZONE
      });
      try {
        if (CalendarApp.Color && CalendarApp.Color.BLUE) {
          newCal.setColor(CalendarApp.Color.BLUE);
        }
      } catch (e) {}
      return newCal;
    } catch (err) {
      console.warn('[Calendar] Secondary calendar creation unavailable, falling back to primary:', err);
      return CalendarApp.getDefaultCalendar();
    }
  }

  /**
   * Synchronizes a single activity row to Google Calendar.
   * Creates an All-Day Event (pinned in top banner with NO reminders before 10 PM)
   * and a paired 10:00 PM Alarm Event (triggers exact 10:00 PM PKT popup alert).
   * Auto-deletes BOTH events immediately if activity is submitted or completed.
   */
  function syncActivityToGoogleCalendar(cal, rowData, rowNum, sheet) {
    var studentId = String(rowData[0] || '').trim();
    var courseCode = String(rowData[3] || 'VU Course').trim();
    var courseName = String(rowData[4] || '').trim();
    var activityTitle = String(rowData[5] || 'Activity').trim();
    var activityType = String(rowData[6] || 'Assignment').trim();
    var rawEndDate = rowData[8];
    var activityUrl = String(rowData[9] || 'https://vulms.vu.edu.pk').trim();
    var status = String(rowData[10] || 'active').trim();
    var existingEventId = String(rowData[19] || '').trim();

    if (!rawEndDate) return null;

    var endDate = formatCellDate(rawEndDate);
    var currentTimestamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    // If submitted or completed: Immediately remove all calendar events for this activity!
    if (status === 'submitted' || status === 'completed') {
      if (existingEventId) {
        var parts = existingEventId.split('|');
        for (var p = 0; p < parts.length; p++) {
          var id = parts[p].trim();
          if (!id) continue;
          try {
            var ev = cal.getEventById(id);
            if (ev) ev.deleteEvent();
          } catch (e) {}
        }
        if (sheet && rowNum) {
          sheet.getRange(rowNum, 20).setValue('');
          sheet.getRange(rowNum, 21).setValue('');
        }
      }
      return null;
    }

    // Build event title and rich description
    var eventTitle = '[' + courseCode + '] ' + activityType + ': ' + activityTitle;
    var alarmTitle = '⏰ [' + courseCode + '] ' + activityType + ': ' + activityTitle + ' (Due Tonight 11:59 PM)';
    var eventDescription = [
      '📚 Course: ' + (courseName ? (courseCode + ' — ' + courseName) : courseCode),
      '📝 Activity: ' + activityTitle,
      '🏷️ Type: ' + activityType,
      '⏰ Due: ' + endDate + ' at 11:59 PM PKT',
      '🔗 Submission Link: ' + activityUrl,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '🎓 Auto-synced by VULMS Smart Deadline Tracker'
    ].join('\n');

    // Target All-Day Deadline Event on endDate (shows in top banner all day)
    var dateParts = endDate.split('-');
    var targetDate = new Date(parseInt(dateParts[0], 10), parseInt(dateParts[1], 10) - 1, parseInt(dateParts[2], 10));

    // Timed 10:00 PM Alarm: 22:00 PKT to 23:59 PKT
    var alarmStart = new Date(parseInt(dateParts[0], 10), parseInt(dateParts[1], 10) - 1, parseInt(dateParts[2], 10), 22, 0, 0);
    var alarmEnd = new Date(parseInt(dateParts[0], 10), parseInt(dateParts[1], 10) - 1, parseInt(dateParts[2], 10), 23, 59, 0);

    var allDayId = '';
    var alarmId = '';
    if (existingEventId) {
      var idParts = existingEventId.split('|');
      allDayId = idParts[0] ? idParts[0].trim() : '';
      alarmId = idParts[1] ? idParts[1].trim() : '';
    }

    // 1. ALL-DAY BANNER EVENT (Pinned to top of Google Calendar throughout the day)
    var allDayEvent = null;
    if (allDayId) {
      try {
        allDayEvent = cal.getEventById(allDayId);
      } catch (e) {
        allDayEvent = null;
      }
    }

    if (allDayEvent) {
      allDayEvent.setTitle(eventTitle);
      if (typeof allDayEvent.setAllDayDate === 'function') {
        allDayEvent.setAllDayDate(targetDate);
      } else {
        allDayEvent.setTime(targetDate, new Date(targetDate.getTime() + 24 * 60 * 60 * 1000));
      }
      allDayEvent.setDescription(eventDescription);
      allDayEvent.setLocation(activityUrl);
    } else {
      allDayEvent = cal.createAllDayEvent(eventTitle, targetDate, {
        description: eventDescription,
        location: activityUrl
      });
    }

    // Clear reminders on all-day event so NO premature notifications trigger before 10:00 PM
    try {
      allDayEvent.removeAllReminders();
    } catch (remErr) {}

    // Color code the all-day event
    try {
      var typeLower = activityType.toLowerCase();
      if (typeLower.includes('quiz')) {
        allDayEvent.setColor(CalendarApp.EventColor ? CalendarApp.EventColor.ORANGE : '6');
      } else if (typeLower.includes('gdb') || typeLower.includes('discussion')) {
        allDayEvent.setColor(CalendarApp.EventColor ? CalendarApp.EventColor.MAUVE : '3');
      } else {
        allDayEvent.setColor(CalendarApp.EventColor ? CalendarApp.EventColor.CYAN : '7');
      }
    } catch (colorErr) {}

    // 2. 10:00 PM ALARM EVENT (Triggers exact 10:00 PM PKT popup notification on phone/desktop)
    var alarmEvent = null;
    if (alarmId) {
      try {
        alarmEvent = cal.getEventById(alarmId);
      } catch (e) {
        alarmEvent = null;
      }
    }

    if (alarmEvent) {
      alarmEvent.setTitle(alarmTitle);
      alarmEvent.setTime(alarmStart, alarmEnd);
      alarmEvent.setDescription(eventDescription);
      alarmEvent.setLocation(activityUrl);
    } else {
      alarmEvent = cal.createEvent(alarmTitle, alarmStart, alarmEnd, {
        description: eventDescription,
        location: activityUrl
      });
    }

    // Set 10:00 PM popup reminder (0 minutes before start of 22:00 PKT)
    try {
      alarmEvent.removeAllReminders();
      alarmEvent.addPopupReminder(0);
    } catch (e) {}

    try {
      alarmEvent.setColor(CalendarApp.EventColor ? CalendarApp.EventColor.RED : '11');
    } catch (e) {}

    var savedEventId = allDayEvent.getId() + '|' + alarmEvent.getId();

    // Persist event IDs and timestamp into Sheet columns T (20) & U (21)
    if (sheet && rowNum) {
      sheet.getRange(rowNum, 20).setValue(savedEventId);
      sheet.getRange(rowNum, 21).setValue(currentTimestamp);
    }

    return savedEventId;
  }

  /**
   * Synchronizes active/pending deadlines from the Google Sheet to Google Calendar.
   * Optimized with smart cache-checking to avoid slow sequential Google Calendar API round-trips.
   *
   * @param {string} [targetStudentId] - Optional student ID filter
   * @param {boolean} [forceRefresh] - Set true to force full re-sync across all events (e.g. from UI menu)
   */
  function syncAllActivitiesToGoogleCalendar(targetStudentId, forceRefresh) {
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return { status: 'success', synced: 0, message: 'No activities found to sync.' };
    }

    var cal = getOrCreateVulmsCalendar();
    var now = new Date();
    var todayPkt = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');

    var syncedCount = 0;
    var updatedCount = 0;
    var errorCount = 0;
    var skippedCount = 0;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var studentId = String(row[0] || '').trim();
      var rawEndDate = row[8];
      var status = String(row[10] || '').trim();
      var existingEventId = String(row[19] || '').trim();
      var calendarSyncedAt = String(row[20] || '').trim();

      if (!rawEndDate) continue;
      var endDate = formatCellDate(rawEndDate);

      // Filter by student if specified
      if (targetStudentId && studentId.toLowerCase() !== targetStudentId.toLowerCase()) {
        continue;
      }

      // Do not recreate past-due historical activities if they don't already have an event
      if (endDate < todayPkt && !existingEventId) {
        continue;
      }

      // Skip cancelled or submitted/completed items, and remove their calendar events if they exist
      if (status === 'cancelled' || status === 'submitted' || status === 'completed') {
        if (existingEventId) {
          var parts = existingEventId.split('|');
          for (var p = 0; p < parts.length; p++) {
            var id = parts[p].trim();
            if (!id) continue;
            try {
              var ev = cal.getEventById(id);
              if (ev) ev.deleteEvent();
            } catch (e) {}
          }
          sheet.getRange(i + 1, 20).setValue('');
          sheet.getRange(i + 1, 21).setValue('');
        }
        continue;
      }

      // High-performance cache check:
      // If event already exists in Google Calendar and is active, skip slow API round-trip!
      if (existingEventId && calendarSyncedAt && !forceRefresh) {
        skippedCount++;
        continue;
      }

      try {
        var hadPriorEvent = !!existingEventId;
        syncActivityToGoogleCalendar(cal, row, i + 1, sheet);
        if (hadPriorEvent) {
          updatedCount++;
        } else {
          syncedCount++;
        }
      } catch (err) {
        console.error('[Calendar Sync] Error syncing row ' + (i + 1) + ':', err);
        errorCount++;
      }
    }

    return {
      status: 'success',
      calendarName: cal.getName(),
      created: syncedCount,
      updated: updatedCount,
      skipped: skippedCount,
      errors: errorCount,
      totalSynced: syncedCount + updatedCount
    };
  }

  /**
   * UI Menu handler: Synchronize all deadlines to Google Calendar (Forces full refresh)
   */
  function syncAllActivitiesFromMenu() {
    var ui = SpreadsheetApp.getUi();
    try {
      var res = syncAllActivitiesToGoogleCalendar(null, true);
      ui.alert(
        '📅 Google Calendar Synced!',
        'Calendar Name: ' + res.calendarName + '\n' +
        'Events Created: ' + res.created + '\n' +
        'Events Updated: ' + res.updated + '\n' +
        (res.skipped > 0 ? ('Events Unchanged: ' + res.skipped + '\n') : '') +
        (res.errors > 0 ? ('Errors: ' + res.errors + '\n') : '') +
        '\nOpen Google Calendar on your phone or computer to see your deadlines!',
        ui.ButtonSet.OK
      );
    } catch (err) {
      ui.alert('Calendar Sync Error', 'Could not sync to Google Calendar:\n' + err.toString(), ui.ButtonSet.OK);
    }
  }

  /**
   * Generates a standard RFC 5545 iCalendar (.ics) string from active sheet deadlines.
   * Can be imported into Apple Calendar, Outlook, and Android calendar applications.
   */
  function generateIcsFeed(targetStudentId) {
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    var now = new Date();
    var nowUtc = Utilities.formatDate(now, 'UTC', "yyyyMMdd'T'HHmmss'Z'");

    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//VULMS Smart Deadline Tracker//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:🎓 VULMS Deadlines',
      'X-WR-TIMEZONE:Asia/Karachi',
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Karachi',
      'X-LIC-LOCATION:Asia/Karachi',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0500',
      'TZOFFSETTO:+0500',
      'TZNAME:PKT',
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE'
    ];

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var studentId = String(row[0] || '').trim();
      var actKey = String(row[1] || ('vulms_act_' + i)).trim();
      var courseCode = String(row[3] || 'VU Course').trim();
      var courseName = String(row[4] || '').trim();
      var activityTitle = String(row[5] || 'Activity').trim();
      var activityType = String(row[6] || 'Assignment').trim();
      var rawEndDate = row[8];
      var activityUrl = String(row[9] || 'https://vulms.vu.edu.pk').trim();
      var status = String(row[10] || 'active').trim();

      if (!rawEndDate || status === 'cancelled' || status === 'submitted' || status === 'completed') continue;

      if (targetStudentId && studentId.toLowerCase() !== targetStudentId.toLowerCase()) {
        continue;
      }

      var formattedEndDate = formatCellDate(rawEndDate);
      var endDateStr = formattedEndDate.replace(/-/g, '');
      var dParts = formattedEndDate.split('-');
      var dtObj = new Date(parseInt(dParts[0], 10), parseInt(dParts[1], 10) - 1, parseInt(dParts[2], 10));
      var nextDay = new Date(dtObj.getTime() + 24 * 60 * 60 * 1000);
      var nextDayStr = Utilities.formatDate(nextDay, CONFIG.TIMEZONE, 'yyyyMMdd');

      var summary = '[' + courseCode + '] ' + activityType + ': ' + activityTitle;
      var cleanSummary = summary.replace(/[,;\\]/g, '\\$&');

      var descText = 'Course: ' + (courseName ? (courseCode + ' - ' + courseName) : courseCode) +
                     '\\nActivity: ' + activityTitle +
                     '\\nType: ' + activityType +
                     '\\nDue: ' + formattedEndDate + ' 11:59 PM PKT' +
                     '\\nSubmission Link: ' + activityUrl +
                     '\\n\\nAuto-synced by VULMS Smart Deadline Tracker';

      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + actKey + '@vulms-tracker');
      lines.push('DTSTAMP:' + nowUtc);
      lines.push('DTSTART;VALUE=DATE:' + endDateStr);
      lines.push('DTEND;VALUE=DATE:' + nextDayStr);
      lines.push('SUMMARY:' + cleanSummary);
      lines.push('DESCRIPTION:' + descText);
      lines.push('URL:' + activityUrl);
      lines.push('STATUS:CONFIRMED');

      // Native Alarm 2 hours before deadline (10:00 PM on due date)
      lines.push('BEGIN:VALARM');
      lines.push('TRIGGER;RELATED=END:-PT2H');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:VULMS Deadline Alert: ' + cleanSummary);
      lines.push('END:VALARM');

      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /**
   * UI Menu handler: Shows modal with student's iCal / Apple Calendar subscription URL
   */
  function showIcalFeedUrlDialog() {
    var ui = SpreadsheetApp.getUi();
    var webAppUrl = '';
    try {
      webAppUrl = ScriptApp.getService().getUrl();
    } catch (e) {}

    var feedUrl = (webAppUrl && webAppUrl.startsWith('https://')) ?
      (webAppUrl + '?feed=ical') :
      'Please deploy your script as a Web App first (Deploy > New deployment > Web app).';

    var webcalUrl = (webAppUrl && webAppUrl.startsWith('https://')) ?
      feedUrl.replace('https://', 'webcal://') :
      '';

    var htmlOutput = HtmlService.createHtmlOutput(
      '<div style="font-family: Arial, sans-serif; padding: 12px; color: #1e293b; line-height: 1.5;">' +
      '  <h3 style="margin-top: 0; color: #0284c7;">📅 Live Calendar Subscription Feed</h3>' +
      '  <p style="font-size: 13px;">Copy this URL to subscribe to your deadlines in <b>Apple Calendar (iPhone / Mac)</b>, <b>Outlook</b>, or <b>Google Calendar</b>:</p>' +
      '  <div style="background: #f1f5f9; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 11px; word-break: break-all; border: 1px solid #cbd5e1; margin-bottom: 15px;">' +
      feedUrl +
      '  </div>' +
      '  <h4 style="font-size: 12px; margin-bottom: 4px; color: #334155;">📱 How to Subscribe on iPhone / iPad:</h4>' +
      '  <ol style="font-size: 12px; padding-left: 20px; margin-top: 0;">' +
      '    <li>Open <b>Settings</b> &gt; <b>Calendar</b> &gt; <b>Accounts</b></li>' +
      '    <li>Tap <b>Add Account</b> &gt; <b>Other</b> &gt; <b>Add Subscribed Calendar</b></li>' +
      '    <li>Paste the URL above and tap <b>Next</b> &gt; <b>Save</b>!</li>' +
      '  </ol>' +
      '  <h4 style="font-size: 12px; margin-bottom: 4px; color: #334155;">💻 How to Subscribe in Outlook:</h4>' +
      '  <ol style="font-size: 12px; padding-left: 20px; margin-top: 0;">' +
      '    <li>Open Outlook Calendar &gt; <b>Add Calendar</b> &gt; <b>Subscribe from web</b></li>' +
      '    <li>Paste the URL above, name it <i>VULMS Deadlines</i>, and click <b>Import</b>!</li>' +
      '  </ol>' +
      '</div>'
    ).setWidth(520).setHeight(380);

    ui.showModalDialog(htmlOutput, '🔗 Calendar Subscription Link');
  }

  /**
   * Action handler: Marks an activity as submitted/completed.
   * Updates sheet status and immediately removes its Google Calendar event.
   */
  function markActivitySubmitted(activityKey, studentId) {
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    var now = new Date();
    var currentTimestamp = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var found = false;
    var calendarDeleted = false;

    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][1]).trim();
      if (key === String(activityKey).trim()) {
        sheet.getRange(i + 1, 11).setValue('submitted'); // status
        sheet.getRange(i + 1, 13).setValue('completed'); // reminder_status
        sheet.getRange(i + 1, 16).setValue(currentTimestamp); // updated_at
        sheet.getRange(i + 1, 17).setValue(currentTimestamp); // last_synced_at

        var calEventId = String(data[i][19] || '').trim();
        if (calEventId) {
          try {
            var cal = getOrCreateVulmsCalendar();
            var parts = calEventId.split('|');
            for (var p = 0; p < parts.length; p++) {
              var id = parts[p].trim();
              if (!id) continue;
              var ev = cal.getEventById(id);
              if (ev) {
                ev.deleteEvent();
                calendarDeleted = true;
              }
            }
            sheet.getRange(i + 1, 20).setValue('');
            sheet.getRange(i + 1, 21).setValue('');
          } catch (e) {
            console.warn('[Calendar] Could not delete event on mark submitted:', e);
          }
        }
        found = true;
        break;
      }
    }

    if (!found) {
      return { status: 'error', message: 'Activity not found: ' + activityKey };
    }

    return {
      status: 'success',
      message: 'Activity marked as submitted. Google Calendar reminder removed.',
      calendarEventDeleted: calendarDeleted
    };
  }

  /**
   * Menu action: Allows student to select any row in Google Sheet and mark it as submitted
   */
  function markSelectedRowAsSubmittedFromMenu() {
    var sheet = getOrCreateActivitiesSheet();
    var activeRange = sheet.getActiveRange();
    var ui = SpreadsheetApp.getUi();

    if (!activeRange) {
      ui.alert('No Selection', 'Please click on a row you want to mark as submitted.', ui.ButtonSet.OK);
      return;
    }

    var row = activeRange.getRow();
    if (row <= 1) {
      ui.alert('Invalid Row', 'Please select an activity row (Row 2 or higher), not the header.', ui.ButtonSet.OK);
      return;
    }

    var data = sheet.getRange(row, 1, 1, 21).getValues()[0];
    var actKey = data[1];
    var actTitle = data[5] || 'Activity';
    var course = data[3] || 'Course';

    var res = markActivitySubmitted(actKey);
    ui.alert(
      '🎉 Activity Marked as Submitted!',
      '[' + course + '] ' + actTitle + '\n\n' +
      'Status: submitted\n' +
      'Alert Status: completed (No further email alerts will be sent)\n' +
      (res.calendarEventDeleted ? 'Google Calendar Event: Deleted (10:00 PM reminder removed)\n' : '') +
      '\nGreat job finishing your task early!',
      ui.ButtonSet.OK
    );
  }

  /**
   * Scans the Activities sheet and purges older duplicate rows.
   * Merges submitted status, promotes verified student credentials, and preserves calendar IDs.
   */
  function deduplicateSheet(targetSheet) {
    var sheet = targetSheet || getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 2) return { removed: 0, kept: data.length - 1 };

    var seenMap = {};
    var rowsToDelete = [];

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var rowNum = r + 1;
      var rStudent = String(row[0] || '').trim().toLowerCase();
      var rKey = String(row[1] || '').trim();
      var rCourse = String(row[3] || '').trim().toUpperCase();
      var rTitle = String(row[5] || '').trim();
      var rType = String(row[6] || '').trim().toLowerCase();
      var rNum = extractActivityNumber(rTitle);
      var rNormT = rTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      var rActIdent = rNum ? ('num_' + rNum) : ('title_' + rNormT);
      var rStatus = String(row[10] || '').trim().toLowerCase();
      var rCalId = String(row[19] || '').trim();
      var rName = String(row[17] || '').trim();
      var rEmail = String(row[18] || '').trim();

      if (!rCourse || !rType) continue;

      var identityKey = rCourse + '_' + rType + '_' + rActIdent;

      if (seenMap[identityKey]) {
        var existing = seenMap[identityKey];
        var primaryRowNum = existing.rowNum;

        // If duplicate was marked submitted, ensure primary is submitted
        if (rStatus === 'submitted') {
          sheet.getRange(primaryRowNum, 11).setValue('submitted');
          sheet.getRange(primaryRowNum, 13).setValue('completed');
          existing.isSubmitted = true;
        }

        // If primary had 'unassigned' studentId but duplicate has real studentId, promote it
        if ((!existing.studentId || existing.studentId === 'unassigned') && rStudent && rStudent !== 'unassigned') {
          sheet.getRange(primaryRowNum, 1).setValue(rStudent);
          existing.studentId = rStudent;
        }
        if ((!existing.studentName || existing.studentName === 'VU Student') && rName && rName !== 'VU Student') {
          sheet.getRange(primaryRowNum, 18).setValue(rName);
        }
        if ((!existing.studentEmail || existing.studentEmail.indexOf('@') === -1) && rEmail && rEmail.indexOf('@') !== -1) {
          sheet.getRange(primaryRowNum, 19).setValue(rEmail);
        }

        // Preserve calendar event ID
        if (!existing.calId && rCalId) {
          sheet.getRange(primaryRowNum, 20).setValue(rCalId);
          existing.calId = rCalId;
        }

        rowsToDelete.push(rowNum);
      } else {
        seenMap[identityKey] = {
          rowNum: rowNum,
          studentId: rStudent,
          studentName: rName,
          studentEmail: rEmail,
          isSubmitted: (rStatus === 'submitted'),
          calId: rCalId,
          key: rKey
        };
      }
    }

    if (rowsToDelete.length > 0) {
      for (var d = rowsToDelete.length - 1; d >= 0; d--) {
        sheet.deleteRow(rowsToDelete[d]);
      }
    }

    return {
      removed: rowsToDelete.length,
      kept: data.length - 1 - rowsToDelete.length
    };
  }

  /**
   * Menu action: Scans the sheet, purges older duplicate rows, promotes unassigned student IDs,
   * and preserves submitted statuses and calendar event IDs.
   */
  function cleanDuplicateRowsFromMenu() {
    var ui = SpreadsheetApp.getUi();
    try {
      var res = deduplicateSheet();
      ui.alert(
        '🧹 Sheet Cleaned & Deduplicated!',
        'Duplicate Rows Removed: ' + res.removed + '\n' +
        'Active & Past Unique Tasks Kept: ' + res.kept + '\n\n' +
        'Your Google Sheet is now clean and deduplicated!',
        ui.ButtonSet.OK
      );
    } catch (err) {
      ui.alert('Error', 'Could not deduplicate sheet: ' + err.message, ui.ButtonSet.OK);
    }
  }


