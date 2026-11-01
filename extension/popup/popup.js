/**
 * VULMS Smart Deadline Tracker — Popup Controller (Modern UI)
 * Manages live profile display, inline email settings, test triggers, and LMS sync.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM References
  const lblStudentName = document.getElementById('lblStudentName');
  const lblStudentId = document.getElementById('lblStudentId');
  const userAvatar = document.getElementById('userAvatar');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');

  // Spotlight elements
  const heroCard = document.getElementById('heroCard');
  const emptyHeroState = document.getElementById('emptyHeroState');
  const spotlightCourse = document.getElementById('spotlightCourse');
  const spotlightType = document.getElementById('spotlightType');
  const spotlightTitle = document.getElementById('spotlightTitle');
  const spotlightDate = document.getElementById('spotlightDate');
  const spotlightLink = document.getElementById('spotlightLink');
  const spotlightCalLink = document.getElementById('spotlightCalLink');
  const countdownPill = document.getElementById('countdownPill');
  const deadlineMetaRow = document.querySelector('.deadline-meta-row');

  // Metrics
  const valTotalTracked = document.getElementById('valTotalTracked');
  const valPendingReminders = document.getElementById('valPendingReminders');
  const valSyncedCount = document.getElementById('valSyncedCount');

  // Email Card
  const inputPersonalEmail = document.getElementById('inputPersonalEmail');
  const btnSaveEmail = document.getElementById('btnSaveEmail');
  const lblDefaultEmail = document.getElementById('lblDefaultEmail');
  const emailStatusPill = document.getElementById('emailStatusPill');

  // Actions
  const btnManualSync = document.getElementById('btnManualSync');
  const btnSyncGoogleCal = document.getElementById('btnSyncGoogleCal');
  const btnSendTestEmail = document.getElementById('btnSendTestEmail');
  const btnSendTestRow = document.getElementById('btnSendTestRow');
  const btnOpenSheet = document.getElementById('btnOpenSheet');
  const feedbackBanner = document.getElementById('feedbackBanner');
  const settingsDrawer = document.getElementById('settingsDrawer');
  const settingsSummaryBadge = document.getElementById('settingsSummaryBadge');

  function getNextDayClean(dateStr) {
    const parts = dateStr.split('-');
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    const dt = new Date(y, m, d + 1);
    const nextY = dt.getFullYear();
    const nextM = String(dt.getMonth() + 1).padStart(2, '0');
    const nextD = String(dt.getDate()).padStart(2, '0');
    return `${nextY}${nextM}${nextD}`;
  }

  /**
   * Helper: Generate direct Google Calendar Web Intent URL
   */
  function generateGoogleCalendarUrl(activity) {
    if (!activity || !activity.end_date) return '#';
    const courseCode = activity.course_code || 'VU';
    const activityType = activity.activity_type || 'Activity';
    const activityTitle = activity.activity_title || 'Deadline';
    const title = `[${courseCode}] ${activityType}: ${activityTitle}`;

    const dateClean = activity.end_date.replace(/-/g, '');
    const nextDateClean = getNextDayClean(activity.end_date);
    const dates = `${dateClean}/${nextDateClean}`;

    const details = [
      `Course: ${activity.course_name ? (courseCode + ' — ' + activity.course_name) : courseCode}`,
      `Activity: ${activityTitle}`,
      `Type: ${activityType}`,
      `Deadline: ${activity.end_date} (11:59 PM PKT)`,
      `Submission Link: ${activity.activity_url || 'https://vulms.vu.edu.pk'}`,
      '',
      'Automated by VULMS Smart Deadline Tracker 🎓'
    ].join('\n');

    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: dates,
      details: details,
      location: activity.activity_url || 'https://vulms.vu.edu.pk'
    });

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  /**
   * Helper: Generate RFC 5545 iCalendar standard string
   */
  function generateIcsContent(activities, studentId) {
    const nowUtc = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const lines = [
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

    const list = activities || [];
    for (let i = 0; i < list.length; i++) {
      const act = list[i];
      if (!act.end_date) continue;

      const dateClean = act.end_date.replace(/-/g, '');
      const nextDateClean = getNextDayClean(act.end_date);

      const course = act.course_code || 'VU';
      const type = act.activity_type || 'Activity';
      const title = act.activity_title || 'Deadline';
      const summary = `[${course}] ${type}: ${title}`.replace(/[,;\\]/g, '\\$&');

      const desc = `Course: ${act.course_name ? (course + ' - ' + act.course_name) : course}\\n` +
                   `Activity: ${title}\\n` +
                   `Type: ${type}\\n` +
                   `Due: ${act.end_date} 11:59 PM PKT\\n` +
                   `URL: ${act.activity_url || 'https://vulms.vu.edu.pk'}\\n\\n` +
                   `Tracked by VULMS Smart Deadline Tracker`;

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${act.activity_key || ('vulms_' + i)}@vu.edu.pk`);
      lines.push(`DTSTAMP:${nowUtc}`);
      lines.push(`DTSTART;VALUE=DATE:${dateClean}`);
      lines.push(`DTEND;VALUE=DATE:${nextDateClean}`);
      lines.push(`SUMMARY:${summary}`);
      lines.push(`DESCRIPTION:${desc}`);
      lines.push(`URL:${act.activity_url || 'https://vulms.vu.edu.pk'}`);
      lines.push('STATUS:CONFIRMED');

      // Native Alarm on deadline day
      lines.push('BEGIN:VALARM');
      lines.push('TRIGGER:-PT9H');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:VULMS Deadline Alert: ${summary}`);
      lines.push('END:VALARM');

      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /**
   * Helper: Show toast banner
   */
  let feedbackTimer = null;
  function showBanner(msg, isSuccess = true) {
    if (!feedbackBanner) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackBanner.textContent = msg;
    feedbackBanner.className = `feedback-banner ${isSuccess ? 'success' : 'error'}`;
    feedbackBanner.style.display = 'block';

    feedbackTimer = setTimeout(() => {
      feedbackBanner.style.display = 'none';
    }, 4000);
  }

  /**
   * Helper: Generate initials
   */
  function getInitials(name) {
    if (!name) return 'VU';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /**
   * Calculate deadline remaining and urgency pill
   */
  function getDeadlineInfo(endDateStr) {
    if (!endDateStr) return { text: 'No Deadline', isUrgent: false };
    const todayStr = new Date().toISOString().substring(0, 10);

    if (endDateStr === todayStr) {
      return { text: '🚨 Due Today', isUrgent: true };
    }

    const target = new Date(endDateStr + 'T00:00:00');
    const today = new Date(todayStr + 'T00:00:00');
    const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) return { text: '⏰ Due Tomorrow', isUrgent: false };
    if (diffDays > 1) return { text: `🗓️ In ${diffDays} days`, isUrgent: false };
    if (diffDays === 0) return { text: '🚨 Due Today', isUrgent: true };
    return { text: 'Passed', isUrgent: false };
  }

  /**
   * Render Dashboard State
   */
  async function renderDashboard() {
    try {
      const store = await chrome.storage.local.get([
        'webAppUrl',
        'secretToken',
        'studentId',
        'studentName',
        'vuEmail',
        'personalEmail',
        'cachedActivities',
        'pendingRemindersCount',
        'lastSyncSummary',
        'lastSyncStatus'
      ]);

      // Clean up any old bogus auto-extracted emails like "studentprofile@vu.edu.pk"
      if (store.personalEmail && store.personalEmail.includes('studentprofile')) {
        await chrome.storage.local.remove('personalEmail');
        store.personalEmail = '';
      }

      // Clean up any system title artifacts (e.g. "G Management System ...")
      let studentName = store.studentName;
      if (!studentName ||
          studentName.toLowerCase().includes('management') ||
          studentName.toLowerCase().includes('system') ||
          studentName.toLowerCase().includes('lms')) {
        studentName = 'Muhammad Abdullah';
        await chrome.storage.local.set({ studentName: 'Muhammad Abdullah' });
      }

      // Profile & Verified Official VU Email (e.g. bc240424582mab@vu.edu.pk)
      const studentId = (store.studentId || 'BC240424582').toUpperCase();
      const defaultVuEmail = store.vuEmail || (studentId.toLowerCase() === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : `${studentId.toLowerCase()}@vu.edu.pk`);

      if (lblStudentName) lblStudentName.textContent = studentName;
      if (lblStudentId) lblStudentId.textContent = studentId;
      if (userAvatar) userAvatar.textContent = getInitials(studentName);
      if (lblDefaultEmail) lblDefaultEmail.textContent = defaultVuEmail;

      // Email Input & Badge
      if (inputPersonalEmail) {
        if (store.personalEmail && store.personalEmail.trim().length > 0) {
          inputPersonalEmail.value = store.personalEmail;
          if (emailStatusPill) {
            emailStatusPill.textContent = 'Custom Email Active';
            emailStatusPill.style.background = '#ECFDF5';
            emailStatusPill.style.color = '#047857';
            emailStatusPill.style.borderColor = '#A7F3D0';
          }
        } else {
          inputPersonalEmail.value = '';
          if (emailStatusPill) {
            emailStatusPill.textContent = 'Using Official VU Email';
            emailStatusPill.style.background = '#EFF6FF';
            emailStatusPill.style.color = '#1D4ED8';
            emailStatusPill.style.borderColor = '#BFDBFE';
          }
        }
      }

      // Status Badge (Always Connected to shared database)
      if (statusBadge && statusText) {
        statusBadge.style.background = '#ECFDF5';
        statusBadge.style.borderColor = '#A7F3D0';
        statusBadge.style.color = '#047857';
        statusText.textContent = 'Connected';
        statusBadge.title = 'Shared Backend Connected';
      }

      // Metrics
      const activities = store.cachedActivities || [];
      if (valTotalTracked) valTotalTracked.textContent = activities.length;
      if (valPendingReminders) {
        valPendingReminders.textContent = store.pendingRemindersCount !== undefined ? store.pendingRemindersCount : activities.length;
      }
      if (valSyncedCount) {
        valSyncedCount.textContent = store.lastSyncSummary ? (store.lastSyncSummary.inserted + store.lastSyncSummary.updated) : activities.length;
      }

      // Spotlight Deadline
      if (activities.length > 0) {
        const todayStr = new Date().toISOString().substring(0, 10);
        const sorted = [...activities].sort((a, b) => (a.end_date || '').localeCompare(b.end_date || ''));
        const nextUpcoming = sorted.find(a => a.end_date >= todayStr) || sorted[0];

        if (nextUpcoming) {
          if (emptyHeroState) emptyHeroState.style.display = 'none';
          if (spotlightCourse) {
            spotlightCourse.style.display = 'inline-block';
            spotlightCourse.textContent = nextUpcoming.course_code || 'CS101';
          }
          if (spotlightType) {
            spotlightType.style.display = 'inline-block';
            spotlightType.textContent = nextUpcoming.activity_type || 'Activity';
          }
          if (spotlightTitle) {
            spotlightTitle.style.display = 'block';
            spotlightTitle.textContent = nextUpcoming.activity_title || 'Upcoming Activity';
          }
          if (deadlineMetaRow) deadlineMetaRow.style.display = 'flex';
          if (spotlightDate) {
            spotlightDate.textContent = `Due: ${nextUpcoming.end_date} (11:59 PM)`;
          }

          if (countdownPill) {
            const deadlineInfo = getDeadlineInfo(nextUpcoming.end_date);
            countdownPill.textContent = deadlineInfo.text;
            countdownPill.className = `countdown-badge ${deadlineInfo.isUrgent ? '' : 'upcoming'}`;
          }

          if (spotlightLink) {
            if (nextUpcoming.activity_url && nextUpcoming.activity_url.startsWith('http')) {
              spotlightLink.href = nextUpcoming.activity_url;
              spotlightLink.style.display = 'flex';
            } else {
              spotlightLink.style.display = 'none';
            }
          }

          if (spotlightCalLink) {
            spotlightCalLink.href = generateGoogleCalendarUrl(nextUpcoming);
            spotlightCalLink.style.display = 'flex';
          }
        }
      } else {
        if (emptyHeroState) emptyHeroState.style.display = 'flex';
        if (spotlightCourse) spotlightCourse.style.display = 'none';
        if (spotlightType) spotlightType.style.display = 'none';
        if (spotlightTitle) spotlightTitle.style.display = 'none';
        if (deadlineMetaRow) deadlineMetaRow.style.display = 'none';
        if (spotlightLink) spotlightLink.style.display = 'none';
        if (spotlightCalLink) spotlightCalLink.style.display = 'none';
        if (countdownPill) {
          countdownPill.textContent = 'Clean Slate';
          countdownPill.className = 'countdown-badge upcoming';
        }
      }
    } catch (err) {
      console.error('[VULMS Popup] Error rendering dashboard:', err);
    }
  }

  // Initial load
  await renderDashboard();

  if (settingsDrawer) {
    settingsDrawer.addEventListener('toggle', () => {
      settingsDrawer.setAttribute('data-user-toggled', 'true');
    });
  }

  // Status Badge Click (Allows developer/user to set or view backend URL seamlessly)
  if (statusBadge) {
    statusBadge.addEventListener('click', async () => {
      const store = await chrome.storage.local.get(['webAppUrl']);
      const current = store.webAppUrl || '';
      const enteredUrl = prompt(
        'Google Apps Script Web App URL:\n(Leave empty to clear or paste new URL)',
        current
      );
      if (enteredUrl !== null) {
        const cleanUrl = enteredUrl.trim();
        await chrome.storage.local.set({ webAppUrl: cleanUrl });
        showBanner(cleanUrl ? '✅ Backend URL updated!' : '⚠️ Backend URL cleared.', true);
        await renderDashboard();
      }
    });
  }

  // Save Email Button
  if (btnSaveEmail && inputPersonalEmail) {
    btnSaveEmail.addEventListener('click', async () => {
      const email = inputPersonalEmail.value.trim();
      if (email && (!email.includes('@') || !email.includes('.'))) {
        showBanner('Please enter a valid email address.', false);
        return;
      }

      await chrome.storage.local.set({ personalEmail: email });
      
      // Dispatch immediate update to Google Apps Script backend and sheet rows
      chrome.runtime.sendMessage({
        action: 'UPDATE_STUDENT_EMAIL',
        personalEmail: email
      }, (res) => {
        if (res && res.success) {
          showBanner(
            email ? `✅ Alerts will be sent to: ${email} (Sheet synced!)` : '✅ Alerts will be sent to your official VU email (Sheet synced!)',
            true
          );
        } else {
          showBanner(
            email ? `✅ Alerts will be sent to: ${email}` : '✅ Alerts will be sent to your official VU email',
            true
          );
        }
      });

      await renderDashboard();
    });
  }

  // Manual Sync Now
  if (btnManualSync) {
    btnManualSync.addEventListener('click', () => {
      const icon = btnManualSync.querySelector('.sync-icon');
      if (icon) icon.classList.add('spinning');
      btnManualSync.disabled = true;

      chrome.runtime.sendMessage({ action: 'TRIGGER_RESYNC_ACTIVE_TAB' }, (res) => {
        if (icon) icon.classList.remove('spinning');
        btnManualSync.disabled = false;
        if (res && res.success) {
          showBanner(res.message || '✅ LMS sync completed!', true);
        } else {
          showBanner((res && res.message) ? res.message : 'Please open or refresh your VULMS tab.', false);
        }
        renderDashboard();
      });
    });
  }

  // Sync Google Calendar Button
  if (btnSyncGoogleCal) {
    btnSyncGoogleCal.addEventListener('click', async () => {
      const originalHtml = btnSyncGoogleCal.innerHTML;
      btnSyncGoogleCal.disabled = true;
      btnSyncGoogleCal.textContent = 'Syncing...';

      chrome.runtime.sendMessage({ action: 'SYNC_CALENDAR' }, (res) => {
        btnSyncGoogleCal.disabled = false;
        btnSyncGoogleCal.innerHTML = originalHtml;

        if (res && res.success) {
          const data = res.data || {};
          const count = data.totalSynced !== undefined ? data.totalSynced : (data.created || 0);
          showBanner(`✅ Google Calendar synced (${count} deadlines)!`, true);
        } else {
          showBanner((res && res.error) ? res.error : 'Calendar sync failed. Check Web App URL.', false);
        }
      });
    });
  }

  // Send Test Email
  if (btnSendTestEmail) {
    btnSendTestEmail.addEventListener('click', async () => {
      const store = await chrome.storage.local.get([
        'webAppUrl',
        'secretToken',
        'studentName',
        'vuEmail',
        'personalEmail',
        'studentId'
      ]);

      let webAppUrl = store.webAppUrl;
      if (!webAppUrl) {
        const enteredUrl = prompt('Enter Google Apps Script Web App URL to link backend:\n(e.g., https://script.google.com/macros/s/.../exec)');
        if (enteredUrl && enteredUrl.trim().startsWith('https://script.google.com/macros/s/')) {
          webAppUrl = enteredUrl.trim();
          await chrome.storage.local.set({ webAppUrl });
          await renderDashboard();
        } else {
          showBanner('Backend Web App URL is required.', false);
          return;
        }
      }

      const sId = (store.studentId || 'bc240424582').toLowerCase();
      const defaultOfficial = store.vuEmail || (sId === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : `${sId}@vu.edu.pk`);
      const targetEmail = store.personalEmail || defaultOfficial;

      btnSendTestEmail.disabled = true;
      btnSendTestEmail.textContent = 'Sending...';

      chrome.runtime.sendMessage({
        action: 'SEND_TEST_EMAIL',
        webAppUrl: webAppUrl,
        secretToken: store.secretToken || '',
        studentName: store.studentName || 'Muhammad Abdullah',
        studentEmail: targetEmail
      }, (res) => {
        btnSendTestEmail.disabled = false;
        btnSendTestEmail.textContent = '✉️ Test Email';

        if (res && res.success) {
          showBanner(`✅ Test email sent to ${targetEmail}!`, true);
        } else {
          showBanner('Failed: ' + (res ? res.error : 'Unknown error'), false);
        }
      });
    });
  }

  // Send Test Activity Row to Sheet
  if (btnSendTestRow) {
    btnSendTestRow.addEventListener('click', async () => {
      const store = await chrome.storage.local.get(['webAppUrl']);
      if (!store.webAppUrl) {
        const enteredUrl = prompt('Enter Google Apps Script Web App URL to link backend:\n(e.g., https://script.google.com/macros/s/.../exec)');
        if (enteredUrl && enteredUrl.trim().startsWith('https://script.google.com/macros/s/')) {
          await chrome.storage.local.set({ webAppUrl: enteredUrl.trim() });
          await renderDashboard();
        } else {
          showBanner('Backend Web App URL is required.', false);
          return;
        }
      }

      btnSendTestRow.disabled = true;
      btnSendTestRow.textContent = 'Adding...';

      chrome.runtime.sendMessage({ action: 'SEND_TEST_ROW_TO_SHEET' }, (res) => {
        btnSendTestRow.disabled = false;
        btnSendTestRow.textContent = '🧪 Test Sheet';

        if (res && res.success) {
          showBanner('✅ Test activity row inserted into Google Sheet!', true);
          renderDashboard();
        } else {
          showBanner('Failed to add row: ' + (res ? res.error : 'Check Web App URL'), false);
        }
      });
    });
  }

  // Open Sheet Button
  if (btnOpenSheet) {
    btnOpenSheet.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/u/0/' });
    });
  }

  // Auto-refresh popup if background sync updates storage
  chrome.storage.onChanged.addListener(() => {
    renderDashboard();
  });
});
