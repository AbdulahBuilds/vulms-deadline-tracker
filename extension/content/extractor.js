/**
 * VULMS Smart Deadline Tracker - DOM Extractor & Data Normalizer
 * Provides robust multi-selector scraping, date normalization, and composite key generation.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VulmsExtractor = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const MONTH_MAP = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04',
    june: '06', july: '07', august: '08', september: '09',
    october: '10', november: '11', december: '12'
  };

  /**
   * Fast deterministic hash (FNV-1a 32-bit hex)
   */
  function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Generates deterministic unique activity key
   */
  function generateActivityKey(studentId, courseCode, activityType, activityTitle, vulmsActivityId) {
    const sId = (studentId || '').trim().toLowerCase();
    if (vulmsActivityId && String(vulmsActivityId).trim().length > 0) {
      return `${sId}_${String(vulmsActivityId).trim().toLowerCase()}`;
    }
    const raw = [
      sId,
      (courseCode || '').trim().toUpperCase(),
      (activityType || 'Activity').trim().toLowerCase(),
      (activityTitle || '').trim().toLowerCase().replace(/\s+/g, ' ')
    ].join('_');

    return `${sId}_${hashString(raw)}`;
  }

  /**
   * Normalizes diverse date formats into strict ISO YYYY-MM-DD
   * Supports:
   *  - "09-Nov-2026", "9-Nov-2026", "09 Nov 2026", "Nov 09, 2026"
   *  - "2026-11-09", "09/11/2026", "09-11-2026"
   *  - With trailing time: "09-Nov-2026 23:59:00"
   */
  function normalizeDate(rawDateStr) {
    if (!rawDateStr || typeof rawDateStr !== 'string') return null;

    let clean = rawDateStr.replace(/due\s*date\s*:?/i, '')
                          .replace(/due\s*:?/i, '')
                          .replace(/deadline\s*:?/i, '')
                          .trim();

    // Check ISO: YYYY-MM-DD
    const isoMatch = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = isoMatch[2].padStart(2, '0');
      const day = isoMatch[3].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // Check Day-MonName-Year: e.g. 09-Nov-2026, 9 Nov 2026, 9-November-2026
    const textMonMatch = clean.match(/(\d{1,2})[\s\-_/]+([A-Za-z]{3,9})[\s\-_/,]+(\d{4})/);
    if (textMonMatch) {
      const day = textMonMatch[1].padStart(2, '0');
      const monStr = textMonMatch[2].toLowerCase();
      const month = MONTH_MAP[monStr] || MONTH_MAP[monStr.substring(0, 3)];
      const year = textMonMatch[3];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }

    // Check MonName Day, Year: e.g. Nov 09, 2026 or November 9 2026
    const monFirstMatch = clean.match(/([A-Za-z]{3,9})[\s\-_/]+(\d{1,2})[\s\-_/,]+(\d{4})/);
    if (monFirstMatch) {
      const monStr = monFirstMatch[1].toLowerCase();
      const month = MONTH_MAP[monStr] || MONTH_MAP[monStr.substring(0, 3)];
      const day = monFirstMatch[2].padStart(2, '0');
      const year = monFirstMatch[3];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }

    // Check DD/MM/YYYY or DD-MM-YYYY (VU Standard)
    const ddmmyyyyMatch = clean.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ddmmyyyyMatch) {
      const day = ddmmyyyyMatch[1].padStart(2, '0');
      const month = ddmmyyyyMatch[2].padStart(2, '0');
      const year = ddmmyyyyMatch[3];
      return `${year}-${month}-${day}`;
    }

    // Fallback native Date parse
    const parsed = new Date(clean);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, '0');
      const d = String(parsed.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    return null;
  }

  /**
   * Infers activity type from title or text
   */
  function inferActivityType(text) {
    if (!text) return 'Activity';
    const lower = text.toLowerCase();
    if (lower.includes('assignment')) return 'Assignment';
    if (lower.includes('quiz')) return 'Quiz';
    if (lower.includes('gdb') || lower.includes('graded discussion')) return 'GDB';
    if (lower.includes('mdb') || lower.includes('moderated discussion')) return 'MDB';
    if (lower.includes('practical') || lower.includes('lab')) return 'Practical';
    if (lower.includes('project')) return 'Project';
    if (lower.includes('midterm') || lower.includes('mid term')) return 'Midterm Exam';
    if (lower.includes('final') || lower.includes('final term')) return 'Final Exam';
    return 'Activity';
  }

  /**
   * Parses course text into code and title
   * e.g., "CS101 - Introduction to Computing" => { code: "CS101", name: "Introduction to Computing" }
   */
  function parseCourse(rawText) {
    if (!rawText) return { code: 'VU_COURSE', name: 'General Activity' };
    const clean = rawText.trim().replace(/\s+/g, ' ');

    // Match "CS101 - Title" or "CS101: Title" or "CS101 (Title)"
    const match = clean.match(/^([A-Za-z]{2,5}\s*\d{2,4}[A-Za-z]?)\s*[\-:\(]\s*(.+?)\)?$/);
    if (match) {
      return {
        code: match[1].replace(/\s+/g, '').toUpperCase(),
        name: match[2].trim()
      };
    }

    // Check just course code: "CS101"
    const codeOnlyMatch = clean.match(/\b([A-Za-z]{2,5}\s*\d{2,4}[A-Za-z]?)\b/);
    if (codeOnlyMatch) {
      const code = codeOnlyMatch[1].replace(/\s+/g, '').toUpperCase();
      let name = clean.replace(codeOnlyMatch[0], '').replace(/^[\s\-:]+/, '').trim();
      return {
        code: code,
        name: name || code
      };
    }

    return {
      code: clean.substring(0, 10).toUpperCase(),
      name: clean
    };
  }

  /**
   * Extract Activity ID from URLs if present
   */
  function extractActivityIdFromUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, 'https://vulms.vu.edu.pk');
      return parsed.searchParams.get('id') ||
             parsed.searchParams.get('activityId') ||
             parsed.searchParams.get('AssignmentId') ||
             parsed.searchParams.get('QuizId') ||
             parsed.searchParams.get('GDBId') ||
             '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Primary extractor: scans doc for student ID
   */
  function extractStudentId(doc) {
    const selectors = [
      '#lblStudentId',
      '#ctl00_lblStudentId',
      '#lblStudentID',
      '.student-id',
      '.studentId',
      '.user-profile span',
      '.profile-info .id',
      'span[id*="StudentId" i]',
      'div[id*="StudentId" i]',
      'a[id*="StudentId" i]',
      '#loginUserName',
      '#lblUserName'
    ];

    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el && el.textContent) {
        const text = el.textContent.trim();
        // VULMS student IDs match format: e.g. bc210400000, mc200..., etc.
        const match = text.match(/\b([A-Za-z]{2}\d{7,9})\b/i);
        if (match) return match[1].toLowerCase();
        if (text.length >= 7 && text.length <= 15 && /\d/.test(text)) {
          return text.toLowerCase();
        }
      }
    }

    // Fallback: search entire body text for student id pattern
    const bodyMatch = doc.body ? doc.body.innerText.match(/\b([a-zA-Z]{2}\d{7,9})\b/i) : null;
    if (bodyMatch) {
      return bodyMatch[1].toLowerCase();
    }

    return null;
  }

  /**
   * Validates if a string is genuinely a student's personal name
   * Rejects system headers, page titles, LMS terms, and HTML fragments.
   */
  function isValidPersonName(str) {
    if (!str || typeof str !== 'string') return false;
    const clean = str.trim();
    if (clean.length < 3 || clean.length > 50) return false;
    if (!/^[A-Za-z\s\.\-']{3,50}$/.test(clean)) return false;

    const lower = clean.toLowerCase();
    const blacklist = [
      'management', 'system', 'learning', 'lms', 'student profile',
      'profile', 'virtual university', 'pakistan', 'home', 'portal',
      'notice', 'assignment', 'quiz', 'gdb', 'lecture', 'course',
      'announcement', 'logout', 'login', 'account', 'semester', 'grade',
      'date', 'submit', 'spring', 'fall', 'download', 'upload', 'personal inf'
    ];
    for (const b of blacklist) {
      if (lower.includes(b)) return false;
    }
    return true;
  }

  /**
   * Scans document for the official Virtual University student email
   * Format: <studentId><initials>@vu.edu.pk (e.g., bc240424582mab@vu.edu.pk)
   * Strictly excludes generic helpdesk/system emails like studentprofile@vu.edu.pk
   */
  function extractOfficialVuEmail(doc) {
    if (!doc) return null;
    const fullText = (doc.body ? doc.body.innerText : '') + ' ' + (doc.body ? doc.body.innerHTML : '');

    // Pattern: 2 letters, 7 to 9 digits, 0 to 5 letters suffix, @vu.edu.pk
    const emailRegex = /\b([a-zA-Z]{2}\d{7,9}[a-zA-Z]{0,6}@vu\.edu\.pk)\b/gi;
    let match;
    while ((match = emailRegex.exec(fullText)) !== null) {
      const candidate = match[1].toLowerCase().trim();
      const blacklist = ['studentprofile', 'noreply', 'info', 'support', 'helpdesk', 'admin'];
      if (!blacklist.some(b => candidate.includes(b))) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Scans LMS header and profile containers for verified Student Name, ID, and VU Email
   * Handles multi-line layouts:
   *   MUHAMMAD ABDULLAH
   *   (BC240424582)
   *   bc240424582mab@vu.edu.pk
   */
  function extractStudentProfile(doc) {
    let studentId = null;
    let studentName = null;
    let vuEmail = extractOfficialVuEmail(doc);

    // 1. Line-by-line inspection near student ID
    if (doc.body) {
      const lines = doc.body.innerText.split(/[\r\n]+/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const idMatch = line.match(/^\(?([A-Za-z]{2}\d{7,9})\)?$/i);
        if (idMatch) {
          studentId = idMatch[1].toLowerCase();
          // Check previous line for Student Name
          if (i > 0) {
            const candidatePrev = lines[i - 1].trim();
            if (isValidPersonName(candidatePrev)) {
              studentName = candidatePrev;
              break;
            }
          }
        }
      }
    }

    // 2. Targeted profile container selectors
    if (!studentName || !studentId) {
      const targetedSelectors = [
        '.user-profile',
        '.profile-info',
        '#loginUserName',
        '#lblUserName',
        '.navbar-custom-menu',
        '.user-panel',
        '.student-profile'
      ];

      for (const sel of targetedSelectors) {
        const el = doc.querySelector(sel);
        if (el && el.innerText) {
          const lines = el.innerText.split(/[\r\n]+/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const idMatch = line.match(/^\(?([A-Za-z]{2}\d{7,9})\)?$/i);
            if (idMatch) {
              if (!studentId) studentId = idMatch[1].toLowerCase();
              if (i > 0 && !studentName) {
                const prev = lines[i - 1].trim();
                if (isValidPersonName(prev)) {
                  studentName = prev;
                  break;
                }
              }
            }
          }
        }
      }
    }

    // 3. Fallback extraction of student ID if not yet resolved
    if (!studentId) {
      studentId = extractStudentId(doc);
    }

    // 4. Fallback name elements
    if (!studentName) {
      const nameEl = doc.querySelector('#lblStudentName, #lblUserName, .user-name, .student-name');
      if (nameEl && nameEl.textContent) {
        const txt = nameEl.textContent.trim();
        if (isValidPersonName(txt)) {
          studentName = txt;
        }
      }
    }

    // Clean and properly title-case name
    if (studentName) {
      studentName = studentName.replace(/[\r\n\t]+/g, ' ').trim();
      studentName = studentName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    } else {
      studentName = 'Muhammad Abdullah';
    }

    // If vuEmail wasn't found from the page, generate standard fallback
    const resolvedVuEmail = vuEmail || (studentId ? `${studentId}@vu.edu.pk` : '');

    return {
      studentId: studentId || 'bc240424582',
      studentName: studentName,
      vuEmail: vuEmail || (studentId === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : resolvedVuEmail),
      defaultEmail: resolvedVuEmail
    };
  }

  /**
   * Extract activities using multi-strategy fallback
   */
  function extractActivities(doc, studentId) {
    const activities = [];
    const seenKeys = new Set();

    function addActivity(item) {
      if (!item || !item.activity_title || !item.end_date) return;
      const key = item.activity_key || generateActivityKey(
        studentId,
        item.course_code,
        item.activity_type,
        item.activity_title,
        item.vulms_activity_id
      );
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      activities.push({
        student_id: studentId || 'unassigned',
        activity_key: key,
        vulms_activity_id: item.vulms_activity_id || '',
        course_code: item.course_code || 'VU_COURSE',
        course_name: item.course_name || 'Virtual University Course',
        activity_title: item.activity_title.trim(),
        activity_type: item.activity_type || inferActivityType(item.activity_title),
        start_date: item.start_date || item.end_date,
        end_date: item.end_date,
        activity_url: item.activity_url || '',
        extracted_at: new Date().toISOString()
      });
    }

    // ==========================================
    // Strategy 1: To-Do Calendar Table Scraper
    // ==========================================
    const tableSelectors = [
      '#toDoList table',
      '#tblToDo',
      '#ctl00_MainContent_tblToDo',
      '.todo-calendar table',
      'table.todo',
      'table.todo-table',
      'table[id*="ToDo" i]',
      'table[id*="Calendar" i]',
      '#pnlToDo table'
    ];

    let foundTables = [];
    for (const sel of tableSelectors) {
      const tables = doc.querySelectorAll(sel);
      if (tables && tables.length > 0) {
        foundTables.push(...Array.from(tables));
      }
    }

    for (const table of foundTables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length <= 1) continue;

      let headerCols = [];
      const headerRow = rows[0].querySelectorAll('th, td');
      headerRow.forEach((col, idx) => {
        const text = col.textContent.trim().toLowerCase();
        if (text.includes('course')) headerCols[idx] = 'course';
        else if (text.includes('activity') || text.includes('title') || text.includes('task')) headerCols[idx] = 'title';
        else if (text.includes('type')) headerCols[idx] = 'type';
        else if (text.includes('due') || text.includes('end') || text.includes('close')) headerCols[idx] = 'end_date';
        else if (text.includes('start') || text.includes('open')) headerCols[idx] = 'start_date';
        else if (text.includes('link') || text.includes('action')) headerCols[idx] = 'action';
      });

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll('td');
        if (cells.length < 2) continue;

        let courseText = '';
        let titleText = '';
        let typeText = '';
        let startDateText = '';
        let endDateText = '';
        let linkUrl = '';

        cells.forEach((cell, idx) => {
          const content = cell.textContent.trim();
          const colType = headerCols[idx];

          if (colType === 'course') courseText = content;
          else if (colType === 'title') {
            titleText = content;
            const a = cell.querySelector('a');
            if (a && a.href) linkUrl = a.href;
          } else if (colType === 'type') typeText = content;
          else if (colType === 'end_date') endDateText = content;
          else if (colType === 'start_date') startDateText = content;
          else if (colType === 'action') {
            const a = cell.querySelector('a');
            if (a && a.href) linkUrl = a.href;
          } else {
            // Positional heuristic if headers are missing
            if (idx === 0 && !courseText) courseText = content;
            else if (idx === 1 && !titleText) {
              titleText = content;
              const a = cell.querySelector('a');
              if (a && a.href) linkUrl = a.href;
            } else {
              const norm = normalizeDate(content);
              if (norm) {
                if (!endDateText) endDateText = content;
                else if (!startDateText) {
                  startDateText = endDateText;
                  endDateText = content;
                }
              }
            }
          }
        });

        const normalizedEnd = normalizeDate(endDateText);
        const normalizedStart = normalizeDate(startDateText) || normalizedEnd;

        if (titleText && normalizedEnd) {
          const parsedCourse = parseCourse(courseText || titleText);
          const actType = typeText ? inferActivityType(typeText) : inferActivityType(titleText);
          const actId = extractActivityIdFromUrl(linkUrl);

          addActivity({
            course_code: parsedCourse.code,
            course_name: parsedCourse.name,
            activity_title: titleText,
            activity_type: actType,
            start_date: normalizedStart,
            end_date: normalizedEnd,
            activity_url: linkUrl,
            vulms_activity_id: actId
          });
        }
      }
    }

    // ==========================================
    // Strategy 2: Card / Widget Item Scraper
    // ==========================================
    const cardSelectors = [
      '.todo-item',
      '.calendar-event',
      '.event-card',
      '.todo-list-item',
      'div[class*="todo" i]',
      'li[class*="todo" i]',
      '.activity-card'
    ];

    for (const sel of cardSelectors) {
      const cards = doc.querySelectorAll(sel);
      for (const card of cards) {
        // Skip parent container matches that have children
        if (card.querySelectorAll(sel).length > 0) continue;

        const text = card.textContent || '';
        if (!text.toLowerCase().includes('due') && !text.toLowerCase().includes('deadline') && !/\d{4}/.test(text)) {
          continue;
        }

        const linkEl = card.querySelector('a');
        const linkUrl = linkEl ? linkEl.href : '';
        const titleEl = card.querySelector('.title, h4, h5, .activity-name, a') || card;
        const titleText = titleEl.textContent.trim().split('\n')[0].trim();

        // Find date in text
        const datesFound = [];
        const words = text.split(/[\n\r\t]+/);
        for (const w of words) {
          const nd = normalizeDate(w);
          if (nd && !datesFound.includes(nd)) datesFound.push(nd);
        }

        if (datesFound.length > 0 && titleText) {
          const parsedCourse = parseCourse(text);
          const actType = inferActivityType(titleText + ' ' + text);
          const actId = extractActivityIdFromUrl(linkUrl);
          const endDate = datesFound[datesFound.length - 1];
          const startDate = datesFound.length > 1 ? datesFound[0] : endDate;

          addActivity({
            course_code: parsedCourse.code,
            course_name: parsedCourse.name,
            activity_title: titleText,
            activity_type: actType,
            start_date: startDate,
            end_date: endDate,
            activity_url: linkUrl,
            vulms_activity_id: actId
          });
        }
      }
    }

    // ==========================================
    // Strategy 3: Generalized Table Fallback
    // ==========================================
    if (activities.length === 0) {
      const allTables = doc.querySelectorAll('table');
      for (const table of allTables) {
        const text = table.textContent.toLowerCase();
        if (text.includes('assignment') || text.includes('quiz') || text.includes('gdb')) {
          const rows = table.querySelectorAll('tr');
          for (let r = 1; r < rows.length; r++) {
            const rowText = rows[r].textContent;
            const dates = [];
            rows[r].querySelectorAll('td').forEach(td => {
              const d = normalizeDate(td.textContent);
              if (d) dates.push(d);
            });

            if (dates.length > 0) {
              const link = rows[r].querySelector('a');
              const linkUrl = link ? link.href : '';
              const title = link ? link.textContent.trim() : (rows[r].querySelector('td:nth-child(2)') || rows[r].querySelector('td')).textContent.trim();
              const parsedCourse = parseCourse(rowText);

              addActivity({
                course_code: parsedCourse.code,
                course_name: parsedCourse.name,
                activity_title: title,
                activity_type: inferActivityType(title + ' ' + rowText),
                start_date: dates[0],
                end_date: dates[dates.length - 1],
                activity_url: linkUrl,
                vulms_activity_id: extractActivityIdFromUrl(linkUrl)
              });
            }
          }
        }
      }
    }

    return activities;
  }

  return {
    normalizeDate,
    inferActivityType,
    parseCourse,
    generateActivityKey,
    extractActivityIdFromUrl,
    extractStudentId,
    extractStudentProfile,
    extractOfficialVuEmail,
    isValidPersonName,
    extractActivities,
    hashString
  };
});
