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
  const btnSendTestEmail = document.getElementById('btnSendTestEmail');
  const btnSendTestRow = document.getElementById('btnSendTestRow');
  const btnOpenSheet = document.getElementById('btnOpenSheet');
  const feedbackBanner = document.getElementById('feedbackBanner');

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
            emailStatusPill.style.background = 'rgba(16, 185, 129, 0.15)';
            emailStatusPill.style.color = '#34d399';
          }
        } else {
          inputPersonalEmail.value = '';
          if (emailStatusPill) {
            emailStatusPill.textContent = 'Using Official VU Email';
            emailStatusPill.style.background = 'rgba(168, 85, 247, 0.15)';
            emailStatusPill.style.color = '#d8b4fe';
          }
        }
      }

      // Status Badge
      if (statusBadge && statusText) {
        if (!store.webAppUrl) {
          statusBadge.style.background = 'rgba(245, 158, 11, 0.15)';
          statusBadge.style.borderColor = 'rgba(245, 158, 11, 0.35)';
          statusBadge.style.color = '#fbbf24';
          statusText.textContent = 'Setup Needed';
          statusBadge.title = 'Click to configure Apps Script Web App URL';
        } else {
          statusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
          statusBadge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
          statusBadge.style.color = '#34d399';
          statusText.textContent = 'Connected';
          statusBadge.title = 'Backend Connected (Click to change URL)';
        }
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
        }
      } else {
        if (emptyHeroState) emptyHeroState.style.display = 'flex';
        if (spotlightCourse) spotlightCourse.style.display = 'none';
        if (spotlightType) spotlightType.style.display = 'none';
        if (spotlightTitle) spotlightTitle.style.display = 'none';
        if (deadlineMetaRow) deadlineMetaRow.style.display = 'none';
        if (spotlightLink) spotlightLink.style.display = 'none';
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
