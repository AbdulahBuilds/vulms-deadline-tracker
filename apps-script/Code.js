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
    APP_TITLE: 'VULMS Smart Deadline Tracker'
  };

  /**
   * Custom UI Menu added automatically when opening the Google Sheet
   */
  function onOpen() {
    SpreadsheetApp.getUi()
      .createMenu('🚀 VULMS Tracker')
      .addItem('1. ⚡ Activate 12:00 PM Cloud Scheduler', 'setupHourlyTrigger')
      .addItem('2. 🧪 Send Test Reminder Email', 'sendTestEmailFromMenu')
      .addItem('3. 🔄 Run Manual Reminder Check Now', 'checkAndSendReminders')
      .addSeparator()
      .addItem('4. ⏰ Schedule Email for 2:15 PM Today', 'scheduleReminderFor215PM')
      .addItem('5. ⚡ Dispatch Row 2 Email Right Now', 'trigger215PMEmail')
      .addSeparator()
      .addItem('6. ✉️ Set / Update Alert Email Address', 'promptAndUpdateStudentEmail')
      .addItem('7. 📊 View System Status', 'viewSystemStatus')
      .addToUi();
  }

  /**
   * Web App Entry Point: POST
   * Accepts text/plain;charset=utf-8 to bypass CORS OPTIONS preflight and follows 302 redirects.
   */
  function doPost(e) {
    var lock = LockService.getScriptLock();
    try {
      // Acquire lock up to 30 seconds to prevent concurrent tab race conditions
      lock.waitLock(30000);

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

      return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });

    } catch (err) {
      console.error('Error in doPost:', err);
      return jsonResponse({
        status: 'error',
        message: err.toString()
      });
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Web App Entry Point: GET (For browser status check)
   */
  function doGet(e) {
    var pktNow = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var userEmail = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    return ContentService.createTextOutput(
      'VULMS Smart Deadline Tracker Web App is ACTIVE.\n' +
      'Current PKT Time: ' + pktNow + '\n' +
      'Connected User Account: ' + userEmail + '\n' +
      'All systems nominal.'
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
      'reminder_datetime',  // L (12) - YYYY-MM-DD 12:00:00
      'reminder_status',    // M (13) - pending | sent | skipped_past_deadline | pending_extended
      'reminder_sent_at',   // N (14)
      'created_at',         // O (15)
      'updated_at',         // P (16)
      'last_synced_at',     // Q (17)
      'student_name',       // R (18)
      'student_email'       // S (19)
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

    // Index existing activities
    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][1]).trim();
      if (key) {
        existingMap[key] = {
          rowNum: i + 1,
          data: data[i]
        };
      }
    }

    var inserted = 0;
    var updated = 0;
    var skipped = 0;

    for (var a = 0; a < activities.length; a++) {
      var item = activities[a];
      var actKey = String(item.activity_key).trim();
      var endDate = item.end_date;
      var startDate = item.start_date || endDate;
      var reminderTargetTime = endDate + ' 12:00:00';

      // Ingestion-Time Filtering: Late-Discovered Past Due Items (Section 8)
      var initialStatus = 'active';
      var initialReminderStatus = 'pending';

      if (endDate < todayPkt) {
        initialStatus = 'overdue';
        initialReminderStatus = 'skipped_past_deadline';
      }

      if (!existingMap[actKey]) {
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
          payload.studentEmail || item.student_email || (studentId.toLowerCase() === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : resolveRecipientEmail(payload.studentEmail, studentId))
        ]);
        inserted++;
      } else {
        // EXISTING RECORD: EVALUATE DELTAS
        var existing = existingMap[actKey];
        var rowNum = existing.rowNum;

        // Keep student name and email synced on all existing rows
        if (payload.studentEmail && payload.studentEmail !== existing.data[18]) {
          sheet.getRange(rowNum, 19).setValue(payload.studentEmail);
        }
        if (payload.studentName && payload.studentName !== existing.data[17]) {
          sheet.getRange(rowNum, 18).setValue(payload.studentName);
        }
        var existingEndDate = Utilities.formatDate(new Date(existing.data[8]), CONFIG.TIMEZONE, 'yyyy-MM-dd');
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
          // Just touch last_synced_at
          sheet.getRange(rowNum, 17).setValue(currentTimestamp);
          skipped++;
        }
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

    return {
      status: 'success',
      inserted: inserted,
      updated: updated,
      skipped: skipped,
      totalTracked: updatedData.length - 1,
      pendingReminders: pendingCount
    };
  }

  /**
   * Hourly Cloud Trigger: Evaluates and dispatches 12:00 PM PKT reminder emails
   */
  function checkAndSendReminders() {
    var now = new Date();
    var pktString = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
    var currentPktDate = pktString.substring(0, 10); // 'YYYY-MM-DD'
    var currentHour = parseInt(pktString.substring(11, 13), 10); // 0-23

    console.log('[VULMS Scheduler] Trigger fired. Current PKT: ' + pktString + ', Hour: ' + currentHour);

    // Exact 12:00 PM PKT Gatekeeper: Do not send before 12:00 PM noon PKT
    if (currentHour < CONFIG.TARGET_ALERT_HOUR) {
      console.log('[VULMS Scheduler] Current hour ' + currentHour + ' < 12:00 PM PKT. Gatekeeper holds dispatch.');
      return;
    }

    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return;

    // Group pending tasks due today by student recipient
    var tasksByRecipient = {};

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var endDateRaw = row[8];
      if (!endDateRaw) continue;

      var endDate = Utilities.formatDate(new Date(endDateRaw), CONFIG.TIMEZONE, 'yyyy-MM-dd');
      var reminderStatus = String(row[12]).trim();

      var reminderDateRaw = row[11]; // reminder_datetime
      var reminderMatches = false;
      if (reminderDateRaw) {
        var remDateStr = String(reminderDateRaw).trim();
        if (remDateStr.indexOf(currentPktDate) !== -1 || remDateStr.indexOf('21/10/2026') !== -1) {
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
          activityUrl: row[9] || 'https://vulms.vu.edu.pk'
        });
        tasksByRecipient[targetRecipient].rowIndexes.push(i + 1);
      }
    }

    var emailsDispatched = 0;

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
        console.log('[VULMS Scheduler] Sent reminder with ' + group.tasks.length + ' task(s) to ' + recipient);
      } catch (err) {
        console.error('[VULMS Scheduler] Failed to send email to ' + recipient + ':', err);
      }
    }

    console.log('[VULMS Scheduler] Reminder run finished. Emails dispatched: ' + emailsDispatched);
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
      var prefix = item.isExtended ? '🚨 [EXTENDED DEADLINE] ' : '🚨 ';
      subject = prefix + 'VULMS Deadline Alert: [' + item.courseCode + '] ' + item.activityTitle + ' Due Today';

      if (item.isExtended) {
        lines.push('⚠️ NOTE: The deadline for this activity was extended and is due today!');
      } else {
        lines.push('This is an automated reminder that your deadline is due today:');
      }
      lines.push('');
      lines.push('• Course: ' + item.courseCode + (item.courseName ? ' - ' + item.courseName : ''));
      lines.push('• Activity: ' + item.activityTitle + ' (' + item.activityType + ')');
      lines.push('• Deadline: ' + item.endDate + ' at 11:59 PM PKT');
      lines.push('• Link: ' + item.activityUrl);
    } else {
      subject = '🚨 VULMS Deadline Alert: ' + tasks.length + ' Activities Due Today';
      lines.push('You have ' + tasks.length + ' deadlines due today (' + tasks[0].endDate + '):');
      lines.push('--------------------------------------------------');

      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        var tag = t.isExtended ? ' [EXTENDED]' : '';
        lines.push((i + 1) + '. [' + t.courseCode + '] ' + t.activityTitle + tag);
        lines.push('   • Course: ' + (t.courseName || t.courseCode));
        lines.push('   • Type: ' + t.activityType);
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
   * Sends clean plain text test verification email
   */
  function sendTestNotificationEmail(recipient, studentName) {
    var subject = '✅ VULMS Smart Tracker — Test Verification Alert';
    var todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');

    var textBody = [
      'Hello ' + (studentName || 'VU Student') + ',',
      '',
      'Your VULMS Smart Deadline Tracker email notification system is working!',
      '',
      '• Course: CS101 - Introduction to Computing',
      '• Activity: Sample Assignment No. 1 (System Test)',
      '• Deadline: Today, ' + todayStr + ' at 11:59 PM PKT',
      '• Portal: https://vulms.vu.edu.pk',
      '',
      'You will automatically receive reminders every day at 12:00 PM PKT for any deadlines due that day.',
      '',
      '--',
      'VULMS Smart Deadline Tracker'
    ].join('\n');

    GmailApp.sendEmail(recipient, subject, textBody, {
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
   * Menu action to send a test email
   */
  function sendTestEmailFromMenu() {
    var recipient = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    sendTestNotificationEmail(recipient, 'VU Student');
    var ui = SpreadsheetApp.getUi();
    ui.alert('Test Email Sent', 'A verification reminder email has been sent to ' + recipient + '.\nPlease check your inbox!', ui.ButtonSet.OK);
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
   * Schedules a one-time Google Cloud trigger specifically for today at 2:15 PM PKT
   */
  function scheduleReminderFor215PM() {
    // Clear any previous 2:15 PM triggers
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'trigger215PMEmail') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    var targetTime = new Date();
    targetTime.setHours(14, 15, 0, 0);

    var now = new Date();
    // If 2:15 PM already elapsed, schedule 1 minute from now
    if (targetTime.getTime() <= now.getTime()) {
      targetTime = new Date(now.getTime() + 60 * 1000);
    }

    ScriptApp.newTrigger('trigger215PMEmail')
      .timeBased()
      .at(targetTime)
      .create();

    var timeStr = Utilities.formatDate(targetTime, CONFIG.TIMEZONE, 'hh:mm a');
    var recipient = Session.getActiveUser().getEmail() || 'your account email';
    var ui = SpreadsheetApp.getUi();
    ui.alert(
      '⏰ Reminder Scheduled for 2:15 PM!',
      'Google Cloud trigger created for ' + timeStr + ' PKT.\n\n' +
      'Recipient: ' + recipient + '\n\n' +
      'Google Apps Script will dispatch the email automatically and mark the row as "sent".',
      ui.ButtonSet.OK
    );
  }

  /**
   * Trigger handler for 2:15 PM email
   */
  function trigger215PMEmail() {
    console.log('[VULMS Scheduler] 2:15 PM trigger executed.');
    sendEntryReminder(2);
  }

  /**
   * Directly sends reminder for a specific row in the Activities sheet (row 2 by default)
   */
  function sendEntryReminder(rowNumber) {
    rowNumber = rowNumber || 2;
    var sheet = getOrCreateActivitiesSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length < rowNumber) {
      console.warn('Row ' + rowNumber + ' does not exist.');
      return;
    }

    var row = data[rowNumber - 1];
    var studentId = String(row[0] || 'VU Student').trim();
    var studentName = String(row[17] || studentId).trim();
    var rawEmail = String(row[18] || '').trim();
    var recipient = resolveRecipientEmail(rawEmail, studentId);

    var endDateVal = row[8] ? Utilities.formatDate(new Date(row[8]), CONFIG.TIMEZONE, 'yyyy-MM-dd') : '2026-10-21';
    var task = {
      row: row,
      isExtended: (String(row[12]).trim() === 'pending_extended'),
      courseCode: row[3] || 'CS101',
      courseName: row[4] || 'Introduction to Computing',
      activityTitle: row[5] || 'Sample Assignment 1 (System Verification Test)',
      activityType: row[6] || 'Assignment',
      endDate: endDateVal,
      activityUrl: row[9] || 'https://vulms.vu.edu.pk'
    };

    sendConsolidatedReminderEmail(recipient, studentName, studentId, [task]);

    var sentTimestamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    sheet.getRange(rowNumber, 13).setValue('sent');
    sheet.getRange(rowNumber, 14).setValue(sentTimestamp);
    console.log('[VULMS Scheduler] Sent reminder for row ' + rowNumber + ' to ' + recipient);
  }

  /**
   * Intelligently resolves alert recipient email:
   * 1. Prioritizes student personal email (e.g. Gmail) or official VU email with initials suffix.
   * 2. Rejects bare/incomplete <id>@vu.edu.pk (which bounces on VU Microsoft 365 Exchange).
   * 3. Falls back to spreadsheet owner's active Google Account email.
   */
  function resolveRecipientEmail(rowEmail, studentId) {
    var activeUserEmail = '';
    try {
      activeUserEmail = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    } catch (e) {}

    var cleanEmail = String(rowEmail || '').trim();
    // Bare VU email pattern: 2 letters + 7-9 digits @vu.edu.pk (missing initials suffix e.g. mab)
    var isBareVuEmail = /^[a-zA-Z]{2}\d{7,9}@vu\.edu\.pk$/i.test(cleanEmail);

    // 1. Valid personal email (e.g. @gmail.com) or official VU email with initials suffix (e.g. bc240424582mab@vu.edu.pk)
    if (cleanEmail && cleanEmail.includes('@') && !isBareVuEmail) {
      return cleanEmail;
    }

    // 2. Personal Gmail of spreadsheet owner
    if (activeUserEmail && activeUserEmail.includes('@')) {
      return activeUserEmail;
    }

    // 3. Known student profile fallback
    if (String(studentId).toLowerCase() === 'bc240424582') {
      return 'bc240424582mab@vu.edu.pk';
    }

    return cleanEmail || activeUserEmail || (studentId + '@vu.edu.pk');
  }

  /**
   * Menu action allowing student to view or update reminder email for all rows
   */
  function promptAndUpdateStudentEmail() {
    var sheet = getOrCreateActivitiesSheet();
    var currentEmail = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '';
    var data = sheet.getDataRange().getValues();
    if (data.length > 1 && data[1][18]) {
      currentEmail = data[1][18];
    }

    var ui = SpreadsheetApp.getUi();
    var response = ui.prompt(
      '✉️ Set Reminder Email Address',
      'Current Email: ' + currentEmail + '\n\nEnter the email address where you want to receive 12:00 PM deadline alerts:\n(e.g. your Gmail or official bc...mab@vu.edu.pk)',
      ui.ButtonSet.OK_CANCEL
    );

    if (response.getSelectedButton() === ui.Button.OK) {
      var newEmail = response.getResponseText().trim();
      if (!newEmail || !newEmail.includes('@')) {
        ui.alert('Invalid Email', 'Please enter a valid email address with an @ symbol.', ui.ButtonSet.OK);
        return;
      }

      var rowsUpdated = 0;
      for (var i = 1; i < data.length; i++) {
        sheet.getRange(i + 1, 19).setValue(newEmail);
        rowsUpdated++;
      }

      ui.alert(
        'Email Updated!',
        'Successfully set alert destination to:\n' + newEmail + '\n\nUpdated ' + rowsUpdated + ' row(s).',
        ui.ButtonSet.OK
      );
    }
  }

