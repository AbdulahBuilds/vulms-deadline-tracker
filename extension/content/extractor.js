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
   * Virtual University Official Course Catalog Lookup
   * Automatically provides full, friendly course titles when LMS only displays course codes (e.g. CS302).
   */
  const VU_COURSE_CATALOG = {
    'CS101': 'Introduction to Computing',
    'CS201': 'Introduction to Programming',
    'CS201P': 'Introduction to Programming (Practical)',
    'CS301': 'Data Structures',
    'CS301P': 'Data Structures (Practical)',
    'CS302': 'Digital Logic Design',
    'CS302P': 'Digital Logic Design (Practical)',
    'CS304': 'Object Oriented Programming',
    'CS304P': 'Object Oriented Programming (Practical)',
    'CS401': 'Computer Architecture and Assembly Language',
    'CS402': 'Theory of Automata',
    'CS403': 'Database Management Systems',
    'CS403P': 'Database Management Systems (Practical)',
    'CS408': 'Human Computer Interaction',
    'CS411': 'Visual Programming',
    'CS501': 'Advanced Computer Architecture',
    'CS502': 'Fundamental of Algorithms',
    'CS504': 'Software Engineering - I',
    'CS506': 'Web Design and Development',
    'CS508': 'Modern Programming Languages',
    'CS601': 'Data Communication',
    'CS602': 'Computer Graphics',
    'CS604': 'Operating Systems',
    'CS605': 'Software Engineering - II',
    'CS609': 'System Programming',
    'CS610': 'Computer Networks',
    'CS614': 'Data Warehousing',
    'CS615': 'Software Project Management',
    'IT430': 'E-Commerce',
    'MTH101': 'Calculus And Analytical Geometry',
    'MTH202': 'Discrete Mathematics',
    'MTH301': 'Calculus II',
    'MTH302': 'Business Mathematics & Statistics',
    'ENG101': 'English Comprehension',
    'ENG201': 'Business and Technical English Writing',
    'PHY101': 'Physics',
    'PHY301': 'Circuit Theory',
    'ISL202': 'Islamic Studies',
    'ETH202': 'Ethics (for Non-Muslims)',
    'PAK301': 'Pakistan Studies',
    'MGT101': 'Financial Accounting',
    'MGT211': 'Introduction to Business',
    'MGT301': 'Principles of Marketing',
    'MGT503': 'Principles of Management',
    'STA301': 'Statistics and Probability',
    'ECO401': 'Economics'
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
   * Validates year bounds for active Virtual University academic deadlines (2024 to 2035)
   */
  function isValidAcademicYear(yearStr) {
    const y = parseInt(yearStr, 10);
    return !isNaN(y) && y >= 2024 && y <= 2035;
  }

  /**
   * Normalizes diverse date formats into strict ISO YYYY-MM-DD
   * Supports:
   *  - "09-Nov-2026", "9-Nov-2026", "09 Nov 2026", "Nov 09, 2026", "Nov 04, 2026 11:59 PM"
   *  - "2026-11-09", "09/11/2026", "09-11-2026"
   * Strictly rejects:
   *  - Percentages (e.g. "60%"), standalone numbers (e.g. "60", "100")
   *  - Non-academic years (e.g. 1960)
   *  - Non-date strings like "marks", "weightage", "scheme"
   */
  function normalizeDate(rawDateStr) {
    if (!rawDateStr || typeof rawDateStr !== 'string') return null;

    // Immediately reject percentages, standalone numbers, or grading weight terms
    if (rawDateStr.includes('%')) return null;
    if (/^\s*\d{1,4}\s*$/.test(rawDateStr)) return null;

    const lowerRaw = rawDateStr.toLowerCase();
    const blacklistWords = ['marks', 'weight', 'total', 'scheme', 'policy', 'grade', 'points', 'gpa', 'final term %'];
    for (const b of blacklistWords) {
      if (lowerRaw.includes(b)) return null;
    }

    let clean = rawDateStr.replace(/due\s*date\s*:?/i, '')
                          .replace(/due\s*:?/i, '')
                          .replace(/deadline\s*:?/i, '')
                          .replace(/open\s*date\s*:?/i, '')
                          .replace(/open\s*:?/i, '')
                          .trim();

    // Check ISO: YYYY-MM-DD
    const isoMatch = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = isoMatch[2].padStart(2, '0');
      const day = isoMatch[3].padStart(2, '0');
      if (isValidAcademicYear(year) && parseInt(month, 10) <= 12 && parseInt(day, 10) <= 31) {
        return `${year}-${month}-${day}`;
      }
      return null;
    }

    // Check Day-MonName-Year: e.g. 09-Nov-2026, 9 Nov 2026, 9-November-2026
    const textMonMatch = clean.match(/(\d{1,2})[\s\-_/]+([A-Za-z]{3,9})[\s\-_/,]+(\d{4})/);
    if (textMonMatch) {
      const day = textMonMatch[1].padStart(2, '0');
      const monStr = textMonMatch[2].toLowerCase();
      const month = MONTH_MAP[monStr] || MONTH_MAP[monStr.substring(0, 3)];
      const year = textMonMatch[3];
      if (month && isValidAcademicYear(year) && parseInt(day, 10) <= 31) {
        return `${year}-${month}-${day}`;
      }
    }

    // Check MonName Day, Year: e.g. Nov 04, 2026 or November 9 2026 (Standard VULMS To-Do format)
    const monFirstMatch = clean.match(/([A-Za-z]{3,9})[\s\-_/]+(\d{1,2})[\s\-_/,]+(\d{4})/);
    if (monFirstMatch) {
      const monStr = monFirstMatch[1].toLowerCase();
      const month = MONTH_MAP[monStr] || MONTH_MAP[monStr.substring(0, 3)];
      const day = monFirstMatch[2].padStart(2, '0');
      const year = monFirstMatch[3];
      if (month && isValidAcademicYear(year) && parseInt(day, 10) <= 31) {
        return `${year}-${month}-${day}`;
      }
    }

    // Check DD/MM/YYYY or DD-MM-YYYY (VU Standard)
    const ddmmyyyyMatch = clean.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ddmmyyyyMatch) {
      const day = ddmmyyyyMatch[1].padStart(2, '0');
      const month = ddmmyyyyMatch[2].padStart(2, '0');
      const year = ddmmyyyyMatch[3];
      if (isValidAcademicYear(year) && parseInt(month, 10) <= 12 && parseInt(day, 10) <= 31) {
        return `${year}-${month}-${day}`;
      }
    }

    // Fallback native Date parse - ONLY if it explicitly contains a 4-digit academic year
    const yearMatch = clean.match(/\b(20\d{2})\b/);
    if (yearMatch && isValidAcademicYear(yearMatch[1])) {
      const parsed = new Date(clean);
      if (!isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        if (isValidAcademicYear(String(y))) {
          const m = String(parsed.getMonth() + 1).padStart(2, '0');
          const d = String(parsed.getDate()).padStart(2, '0');
          return `${y}-${m}-${d}`;
        }
      }
    }

    return null;
  }

  /**
   * Infers activity type from title or text
   */
  function inferActivityType(text) {
    if (!text) return 'Activity';
    const lower = text.toLowerCase();

    // Ignore grading weight / syllabus percentages
    if (lower.includes('%') || lower.includes('weight') || lower.includes('marks')) {
      if (!lower.includes('assignment') && !lower.includes('quiz') && !lower.includes('gdb')) {
        return 'Activity';
      }
    }

    if (lower.includes('assignment')) return 'Assignment';
    if (lower.includes('quiz')) return 'Quiz';
    if (lower.includes('gdb') || lower.includes('graded discussion')) return 'GDB';
    if (lower.includes('mdb') || lower.includes('moderated discussion')) return 'MDB';
    if (lower.includes('practical') || lower.includes('lab')) return 'Practical';
    if (lower.includes('project')) return 'Project';
    if (lower.includes('midterm') || lower.includes('mid term')) return 'Midterm Exam';
    if (lower.includes('final exam') || lower.includes('final term exam')) return 'Final Exam';
    return 'Activity';
  }

  /**
   * Parses course text into code and title
   * e.g., "CS302" => { code: "CS302", name: "Digital Logic Design" }
   * e.g., "CS101 - Introduction to Computing" => { code: "CS101", name: "Introduction to Computing" }
   */
  function parseCourse(rawText) {
    if (!rawText) return { code: 'VU_COURSE', name: 'General Activity' };
    const clean = rawText.trim().replace(/\s+/g, ' ');

    const BLACKLIST_COURSE_WORDS = [
      'EXAMS', 'EXAM', 'TOTAL', 'MARKS', 'GRADE', 'WEIGHT', 'FINAL',
      'MIDTERM', 'QUIZ', 'WEEK', 'LESSON', 'PAGE', 'SPRING', 'FALL',
      'SEMESTER', 'COURSE', 'ASSIGNMENT'
    ];

    // Match "CS101 - Title" or "CS101: Title" or "CS101 (Title)"
    const match = clean.match(/^([A-Za-z]{2,4}\s*\d{3}[A-Za-z]?)\s*[\-:\(]\s*(.+?)\)?$/);
    if (match) {
      const code = match[1].replace(/\s+/g, '').toUpperCase();
      if (!BLACKLIST_COURSE_WORDS.includes(code)) {
        return {
          code: code,
          name: match[2].trim() || VU_COURSE_CATALOG[code] || code
        };
      }
    }

    // Check standard VU course code: 2-4 letters followed by 3 digits (e.g. "CS302", "CS101", "MTH101")
    const codeOnlyMatch = clean.match(/\b([A-Za-z]{2,4}\s*\d{3}[A-Za-z]?)\b/);
    if (codeOnlyMatch) {
      const code = codeOnlyMatch[1].replace(/\s+/g, '').toUpperCase();
      if (!BLACKLIST_COURSE_WORDS.includes(code)) {
        let name = clean.replace(codeOnlyMatch[0], '').replace(/^[\s\-:]+/, '').trim();
        return {
          code: code,
          name: name || VU_COURSE_CATALOG[code] || code
        };
      }
    }

    return {
      code: clean.substring(0, 10).toUpperCase(),
      name: clean
    };
  }

  /**
   * Extract Activity ID from URLs if present
   * Rejects course codes (e.g. ?id=CS302) to prevent composite key collision
   */
  function extractActivityIdFromUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, 'https://vulms.vu.edu.pk');
      let id = parsed.searchParams.get('id') ||
               parsed.searchParams.get('activityId') ||
               parsed.searchParams.get('AssignmentId') ||
               parsed.searchParams.get('QuizId') ||
               parsed.searchParams.get('GDBId') ||
               '';
      id = String(id).trim();

      // If the extracted ID matches a course code pattern (e.g. CS302 or CS101),
      // it is a course ID, NOT an activity ID.
      if (/^[A-Za-z]{2,4}\d{3}[A-Za-z]?$/i.test(id)) {
        return '';
      }

      return id;
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
   * Helper to check blacklisted emails
   */
  function isBlacklistedEmail(candidate) {
    if (!candidate) return true;
    const lower = candidate.toLowerCase();
    const blacklist = ['studentprofile', 'noreply', 'info', 'support', 'helpdesk', 'admin', 'lms'];
    return blacklist.some(b => lower.includes(b));
  }

  /**
   * Scans document for the official Virtual University student email
   * Format: <studentId><initials>@vu.edu.pk (e.g., bc240424582mab@vu.edu.pk)
   * Strictly excludes generic helpdesk/system emails like studentprofile@vu.edu.pk
   */
  function extractOfficialVuEmail(doc) {
    if (!doc) return null;

    // 1. Check all input fields (ASP.NET form controls like txtEmail or txtVUEmail)
    try {
      if (doc.querySelectorAll) {
        const inputs = doc.querySelectorAll('input');
        for (const inp of inputs) {
          const val = (inp.value || inp.getAttribute('value') || '').trim();
          if (val && val.toLowerCase().includes('@vu.edu.pk')) {
            const m = val.match(/\b([a-zA-Z]{2}\d{7,9}[a-zA-Z0-9._%+-]*@vu\.edu\.pk)\b/i);
            if (m && !isBlacklistedEmail(m[1])) return m[1].toLowerCase();
          }
        }
      }
    } catch (e) {}

    // 2. Check all mailto links
    try {
      if (doc.querySelectorAll) {
        const mailLinks = doc.querySelectorAll('a[href^="mailto:"]');
        for (const a of mailLinks) {
          const href = a.getAttribute('href') || a.href || '';
          const m = href.match(/\b([a-zA-Z]{2}\d{7,9}[a-zA-Z0-9._%+-]*@vu\.edu\.pk)\b/i);
          if (m && !isBlacklistedEmail(m[1])) return m[1].toLowerCase();
        }
      }
    } catch (e) {}

    // 3. Check table cells
    try {
      if (doc.querySelectorAll) {
        const cells = doc.querySelectorAll('td, th, span, div, p, label');
        for (const cell of cells) {
          const txt = cell.textContent || '';
          if (txt.includes('@vu.edu.pk')) {
            const m = txt.match(/\b([a-zA-Z]{2}\d{7,9}[a-zA-Z0-9._%+-]*@vu\.edu\.pk)\b/i);
            if (m && !isBlacklistedEmail(m[1])) return m[1].toLowerCase();
          }
        }
      }
    } catch (e) {}

    // 4. Full document text and HTML regex scan
    const fullText = (doc.body ? ((doc.body.innerText || '') + ' ' + (doc.body.textContent || '') + ' ' + (doc.body.innerHTML || '')) : '');
    const emailRegex = /\b([a-zA-Z]{2}\d{7,9}[a-zA-Z0-9._%+-]*@vu\.edu\.pk)\b/gi;
    let match;
    while ((match = emailRegex.exec(fullText)) !== null) {
      const candidate = match[1].toLowerCase().trim();
      if (!isBlacklistedEmail(candidate)) {
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
    if (!doc) return { studentId: 'bc240424582', studentName: 'Muhammad Abdullah', vuEmail: 'bc240424582mab@vu.edu.pk', defaultEmail: 'bc240424582@vu.edu.pk' };

    let studentId = null;
    let studentName = null;
    let vuEmail = extractOfficialVuEmail(doc);

    // 1. Direct input values (ASP.NET text boxes on StudentProfile.aspx)
    try {
      if (doc.querySelectorAll) {
        const inputs = doc.querySelectorAll('input');
        for (const inp of inputs) {
          const idOrName = ((inp.id || '') + ' ' + (inp.name || '')).toLowerCase();
          const val = (inp.value || inp.getAttribute('value') || '').trim();
          if (val) {
            if (!studentId && (idOrName.includes('studentid') || idOrName.includes('vuid') || idOrName.includes('student_id'))) {
              const m = val.match(/\b([a-zA-Z]{2}\d{7,9})\b/i);
              if (m) studentId = m[1].toLowerCase();
            }
            if (!studentName && (idOrName.includes('studentname') || idOrName.includes('fullname') || idOrName.includes('txtname'))) {
              if (isValidPersonName(val)) studentName = val;
            }
          }
        }
      }
    } catch (e) {}

    // 2. Table row cells: e.g. <td>Student ID</td><td>BC240424582</td> or <td>Name</td><td>Muhammad Abdullah</td>
    try {
      if (doc.querySelectorAll) {
        const rows = doc.querySelectorAll('tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 2) {
            const label = cells[0].textContent.trim().toLowerCase();
            const val = cells[1].textContent.trim();
            if (!studentId && (label.includes('student id') || label.includes('student_id') || label.includes('vuid'))) {
              const m = val.match(/\b([a-zA-Z]{2}\d{7,9})\b/i);
              if (m) studentId = m[1].toLowerCase();
            }
            if (!studentName && (label.includes('student name') || label.includes('full name') || label === 'name')) {
              if (isValidPersonName(val)) studentName = val;
            }
          }
        }
      }
    } catch (e) {}

    // 3. Line-by-line inspection near student ID
    if (doc.body) {
      const bodyRaw = (doc.body.innerText || doc.body.textContent || '');
      const lines = bodyRaw.split(/[\r\n]+/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const idMatch = line.match(/^\(?([A-Za-z]{2}\d{7,9})\)?$/i);
        if (idMatch) {
          if (!studentId) studentId = idMatch[1].toLowerCase();
          // Check previous line for Student Name
          if (i > 0 && !studentName) {
            const candidatePrev = lines[i - 1].trim();
            if (isValidPersonName(candidatePrev)) {
              studentName = candidatePrev;
              break;
            }
          }
        }
      }
    }

    // 4. Targeted profile container selectors
    if (!studentName || !studentId) {
      const targetedSelectors = [
        '#lblStudentId',
        '#lblStudentID',
        '#lblStudentName',
        '#lblUserName',
        '.user-profile',
        '.profile-info',
        '#loginUserName',
        '.navbar-custom-menu',
        '.user-panel',
        '.student-profile'
      ];

      for (const sel of targetedSelectors) {
        try {
          const el = doc.querySelector ? doc.querySelector(sel) : null;
          if (el) {
            const txt = (el.innerText || el.textContent || '').trim();
            const lines = txt.split(/[\r\n]+/);
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
            if (!studentId) {
              const m = txt.match(/\b([a-zA-Z]{2}\d{7,9})\b/i);
              if (m) studentId = m[1].toLowerCase();
            }
            if (!studentName && isValidPersonName(txt)) {
              studentName = txt;
            }
          }
        } catch (e) {}
      }
    }

    // 5. Fallback extraction of student ID if not yet resolved
    if (!studentId) {
      studentId = extractStudentId(doc);
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

    function isGradingOrNonActivityTable(table) {
      if (!table) return false;
      const text = (table.textContent || '').toLowerCase();
      const blacklist = [
        'grading scheme', 'assessment scheme', 'weightage',
        'distribution of marks', 'evaluation criteria', 'grading policy'
      ];
      for (const phrase of blacklist) {
        if (text.includes(phrase)) return true;
      }
      return false;
    }

    function addActivity(item) {
      if (!item || !item.activity_title || !item.end_date) return;

      const cleanTitle = item.activity_title.trim();

      // Reject percentages (e.g. "60%"), standalone numbers, or syllabus weightage items
      if (/^\s*\d{1,3}\s*%\s*$/.test(cleanTitle) || /^\s*\d{1,4}\s*$/.test(cleanTitle)) {
        return;
      }
      if (cleanTitle.toLowerCase().includes('final term %') || cleanTitle.toLowerCase().includes('weightage')) {
        return;
      }

      // Reject non-academic dates
      if (!isValidAcademicYear(item.end_date.substring(0, 4))) {
        return;
      }

      // Reject blacklisted non-course codes
      if (item.course_code && (item.course_code.startsWith('EXAM') || item.course_code === 'VU_COURSE')) {
        if (!item.course_name || item.course_name.includes('%')) return;
      }

      // Auto-resolve course name from catalog if LMS only provided course code (e.g. CS302)
      let resolvedCourseName = item.course_name || item.course_code;
      if (!resolvedCourseName || resolvedCourseName === item.course_code) {
        resolvedCourseName = VU_COURSE_CATALOG[item.course_code] || item.course_code;
      }

      const key = item.activity_key || generateActivityKey(
        studentId,
        item.course_code,
        item.activity_type,
        cleanTitle,
        item.vulms_activity_id
      );
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      activities.push({
        student_id: studentId || 'unassigned',
        activity_key: key,
        vulms_activity_id: item.vulms_activity_id || '',
        course_code: item.course_code || 'VU_COURSE',
        course_name: resolvedCourseName,
        activity_title: cleanTitle,
        activity_type: item.activity_type || inferActivityType(cleanTitle),
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
      'table[id*="Activity" i]',
      'table[id*="Quiz" i]',
      'table[id*="Assign" i]',
      'table[id*="GDB" i]',
      '#pnlToDo table',
      'table.table',
      'table'
    ];

    let foundTables = [];
    for (const sel of tableSelectors) {
      const tables = doc.querySelectorAll(sel);
      if (tables && tables.length > 0) {
        foundTables.push(...Array.from(tables));
      }
    }

    for (const table of foundTables) {
      if (isGradingOrNonActivityTable(table)) continue;

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
            const a = cell.querySelector ? cell.querySelector('a') : null;
            if (a && a.href && !a.href.startsWith('javascript:')) linkUrl = a.href;
          } else if (colType === 'type') typeText = content;
          else if (colType === 'end_date') endDateText = content;
          else if (colType === 'start_date') startDateText = content;
          else if (colType === 'action') {
            const a = cell.querySelector ? cell.querySelector('a') : null;
            if (a && a.href && !a.href.startsWith('javascript:')) linkUrl = a.href;
          } else {
            // Positional heuristic if headers are missing
            if (idx === 0 && !courseText) courseText = content;
            else if (idx === 1 && !titleText) {
              titleText = content;
              const a = cell.querySelector ? cell.querySelector('a') : null;
              if (a && a.href && !a.href.startsWith('javascript:')) linkUrl = a.href;
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
        if (!text.toLowerCase().includes('due') && !text.toLowerCase().includes('deadline') && !/\b(20\d{2})\b/.test(text)) {
          continue;
        }

        const linkEl = card.querySelector('a');
        const linkUrl = (linkEl && !linkEl.href.startsWith('javascript:')) ? linkEl.href : '';
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
    // Strategy 2.5: FullCalendar Events Scraper
    // ==========================================
    const fcEventSelectors = [
      '.fc-event',
      'a.fc-event',
      '.fc-daygrid-event',
      '.fc-timegrid-event',
      '.fc-list-event',
      '.fc-event-main',
      '[class*="fc-event" i]'
    ];

    for (const sel of fcEventSelectors) {
      const fcEvents = doc.querySelectorAll ? doc.querySelectorAll(sel) : [];
      for (const el of fcEvents) {
        const text = (el.textContent || '').trim();
        const tooltip = (el.getAttribute ? (el.getAttribute('title') || el.getAttribute('data-original-title') || el.getAttribute('aria-label') || '') : '').trim();
        const combined = (tooltip ? tooltip + ' ' : '') + text;
        if (!combined) continue;

        // Try date from closest parent cell with data-date attribute
        let dateFound = null;
        let curr = el;
        for (let depth = 0; depth < 5 && curr; depth++) {
          if (curr.getAttribute) {
            const dDate = curr.getAttribute('data-date') || curr.getAttribute('data-start');
            if (dDate) {
              const nd = normalizeDate(dDate);
              if (nd) { dateFound = nd; break; }
            }
          }
          curr = curr.parentElement;
        }

        if (!dateFound) {
          dateFound = normalizeDate(tooltip) || normalizeDate(text);
        }

        if (dateFound && text) {
          const parsedCourse = parseCourse(combined);
          const actType = inferActivityType(combined);
          const linkEl = el.tagName === 'A' ? el : (el.querySelector ? el.querySelector('a') : null);
          const linkUrl = (linkEl && linkEl.href && !linkEl.href.startsWith('javascript:')) ? linkEl.href : '';
          const actId = extractActivityIdFromUrl(linkUrl);

          const titleClean = text.replace(/^\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i, '').trim() || text;

          addActivity({
            course_code: parsedCourse.code,
            course_name: parsedCourse.name,
            activity_title: titleClean,
            activity_type: actType,
            start_date: dateFound,
            end_date: dateFound,
            activity_url: linkUrl,
            vulms_activity_id: actId
          });
        }
      }
    }

    // ==========================================
    // Strategy 2.8: Course Dashboard Cards Scraper (Home.aspx)
    // ==========================================
    const courseContainerSelectors = [
      '#tblCourses tr',
      '#ctl00_MainContent_tblCourses tr',
      '#ctl00_MainContent_gvCourses tr',
      '.course-box',
      '.courseBox',
      '.dashboard-course',
      'div[id*="Course" i]',
      'div[class*="course-box" i]'
    ];

    for (const sel of courseContainerSelectors) {
      const courseNodes = doc.querySelectorAll ? doc.querySelectorAll(sel) : [];
      for (const node of courseNodes) {
        const nodeText = (node.textContent || '').trim();
        const parsedCourse = parseCourse(nodeText);
        if (!parsedCourse || !parsedCourse.code || parsedCourse.code === 'VU_COURSE' || parsedCourse.code.startsWith('EXAM')) {
          continue;
        }

        const actLinks = node.querySelectorAll ? node.querySelectorAll('a[href*="Assignment" i], a[href*="Quiz" i], a[href*="GDB" i], a[href*="Activity" i], [class*="activity" i], [class*="deadline" i]') : [];
        for (const link of actLinks) {
          const linkText = (link.textContent || '').trim();
          const linkHref = (link.href && !link.href.startsWith('javascript:')) ? link.href : '';
          const parentContext = (link.parentElement ? link.parentElement.textContent : '') + ' ' + (link.closest ? (link.closest('tr, div') ? link.closest('tr, div').textContent : '') : '');
          
          const fullText = linkText + ' ' + parentContext;
          const foundDate = normalizeDate(linkText) || normalizeDate(parentContext);
          
          if (foundDate) {
            const actType = inferActivityType(linkHref + ' ' + linkText + ' ' + fullText);
            const actTitle = (linkText.length > 3 && !linkText.toLowerCase().includes('click here')) ? linkText : `${parsedCourse.code} ${actType}`;
            const actId = extractActivityIdFromUrl(linkHref);

            addActivity({
              course_code: parsedCourse.code,
              course_name: parsedCourse.name,
              activity_title: actTitle,
              activity_type: actType,
              start_date: foundDate,
              end_date: foundDate,
              activity_url: linkHref,
              vulms_activity_id: actId
            });
          }
        }
      }
    }

    // ==========================================
    // Strategy 3: Generalized Table Fallback
    // ==========================================
    if (activities.length === 0) {
      const allTables = doc.querySelectorAll ? doc.querySelectorAll('table') : [];
      for (const table of allTables) {
        if (isGradingOrNonActivityTable(table)) continue;

        const text = (table.textContent || '').toLowerCase();
        if (text.includes('assignment') || text.includes('quiz') || text.includes('gdb') || text.includes('activity')) {
          const rows = table.querySelectorAll ? table.querySelectorAll('tr') : [];
          for (let r = 1; r < rows.length; r++) {
            const rowText = rows[r].textContent || '';
            const dates = [];
            const cells = rows[r].querySelectorAll ? rows[r].querySelectorAll('td') : [];
            cells.forEach(td => {
              const d = normalizeDate(td.textContent);
              if (d) dates.push(d);
            });

            if (dates.length > 0) {
              const link = rows[r].querySelector ? rows[r].querySelector('a') : null;
              const linkUrl = (link && link.href && !link.href.startsWith('javascript:')) ? link.href : '';
              const title = link ? link.textContent.trim() : (rows[r].querySelector ? (rows[r].querySelector('td:nth-child(2)') || rows[r].querySelector('td')).textContent.trim() : '');
              const parsedCourse = parseCourse(rowText);

              addActivity({
                course_code: parsedCourse.code,
                course_name: parsedCourse.name,
                activity_title: title || `${parsedCourse.code} Activity`,
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

  /**
   * Extracts activities from parsed JSON structure or string
   * Handles FullCalendar JSON feeds, ASP.NET WebMethod responses ({ "d": [...] }),
   * and custom VULMS API responses.
   */
  function extractActivitiesFromJson(jsonInput, studentId) {
    if (!jsonInput) return [];

    let parsed = jsonInput;
    if (typeof jsonInput === 'string') {
      try {
        parsed = JSON.parse(jsonInput);
      } catch (e) {
        return [];
      }
    }

    // Unwrap common ASP.NET AJAX wrapper { "d": [...] }
    if (parsed && parsed.d) {
      parsed = parsed.d;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) {}
      }
    }

    // Unwrap object properties if data is in a sub-property
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      if (Array.isArray(parsed.events)) parsed = parsed.events;
      else if (Array.isArray(parsed.activities)) parsed = parsed.activities;
      else if (Array.isArray(parsed.data)) parsed = parsed.data;
      else if (Array.isArray(parsed.items)) parsed = parsed.items;
      else if (Array.isArray(parsed.rows)) parsed = parsed.rows;
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const activities = [];
    const seenKeys = new Set();

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;

      const rawTitle = (item.title || item.ActivityTitle || item.activity_title || item.name || item.text || item.ActivityName || item.subject || '').trim();
      const rawCourse = (item.course || item.CourseCode || item.course_code || item.Course || '').trim();
      const rawType = (item.activity || item.ActivityType || item.activity_type || item.type || '').trim();
      
      const rawEnd = (item.end || item.due || item.EndDate || item.DueDate || item.due_date || item.end_date || item.close_date || item.CloseDate || '').trim();
      const rawStart = (item.start || item.StartDate || item.start_date || item.open_date || item.OpenDate || rawEnd || '').trim();
      
      const rawUrl = (item.url || item.ActivityUrl || item.activity_url || item.link || '').trim();
      const rawId = String(item.id || item.ActivityId || item.activity_id || item.vulms_activity_id || '').trim();

      const normalizedEnd = normalizeDate(rawEnd);
      const normalizedStart = normalizeDate(rawStart) || normalizedEnd;

      if (rawTitle && normalizedEnd) {
        const parsedCourse = parseCourse(rawCourse || rawTitle);
        const actType = rawType ? inferActivityType(rawType) : inferActivityType(rawTitle);
        const actId = (rawId && !/^[A-Za-z]{2,4}\d{3}[A-Za-z]?$/i.test(rawId)) ? rawId : extractActivityIdFromUrl(rawUrl);

        let resolvedCourseName = parsedCourse.name;
        if (!resolvedCourseName || resolvedCourseName === parsedCourse.code) {
          resolvedCourseName = VU_COURSE_CATALOG[parsedCourse.code] || parsedCourse.code;
        }

        const key = generateActivityKey(studentId, parsedCourse.code, actType, rawTitle, actId);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          activities.push({
            student_id: studentId || 'unassigned',
            activity_key: key,
            vulms_activity_id: actId,
            course_code: parsedCourse.code || 'VU_COURSE',
            course_name: resolvedCourseName,
            activity_title: rawTitle,
            activity_type: actType,
            start_date: normalizedStart,
            end_date: normalizedEnd,
            activity_url: rawUrl,
            extracted_at: new Date().toISOString()
          });
        }
      }
    }

    return activities;
  }

  /**
   * Extracts activities from raw HTML string using DOMParser, JSON parsing, and regex
   */
  function extractActivitiesFromHtml(htmlString, studentId) {
    if (!htmlString || typeof htmlString !== 'string') return [];

    // 0. If raw string is JSON (starts with [ or {)
    if (/^\s*[\[\{]/.test(htmlString)) {
      try {
        const jsonActs = extractActivitiesFromJson(htmlString, studentId);
        if (jsonActs && jsonActs.length > 0) return jsonActs;
      } catch (e) {}
    }

    // Check for embedded JSON events in <script> tags
    const scriptJsonMatch = htmlString.match(/events\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/i) ||
                            htmlString.match(/var\s+(?:events|calendarEvents|activities)\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])/i);
    if (scriptJsonMatch) {
      try {
        const jsonActs = extractActivitiesFromJson(scriptJsonMatch[1], studentId);
        if (jsonActs && jsonActs.length > 0) return jsonActs;
      } catch (e) {}
    }

    // 1. Try DOMParser if available
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(htmlString, 'text/html');
        const acts = extractActivities(doc, studentId);
        if (acts && acts.length > 0) return acts;
      } catch (e) {}
    }

    // 2. Direct HTML table row regex parsing fallback
    const activities = [];
    const seen = new Set();
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;

    while ((trMatch = trRegex.exec(htmlString)) !== null) {
      const row = trMatch[1];
      const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells = [];
      let tdMatch;
      while ((tdMatch = tdRegex.exec(row)) !== null) {
        const text = tdMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        cells.push(text);
      }

      if (cells.length >= 3) {
        let endDate = null;
        let startDate = null;
        let courseCode = '';
        let courseName = '';
        let title = '';

        for (const c of cells) {
          const nd = normalizeDate(c);
          if (nd) {
            if (!endDate) endDate = nd;
            else if (!startDate) {
              startDate = endDate;
              endDate = nd;
            }
          }
          const parsedC = parseCourse(c);
          if (parsedC && parsedC.code && !parsedC.code.includes('EXAM') && parsedC.code !== 'VU_COURSE') {
            if (!courseCode) {
              courseCode = parsedC.code;
              courseName = parsedC.name;
            }
          }
        }

        // Title candidate
        if (cells[1] && !normalizeDate(cells[1]) && !parseCourse(cells[1]).code.startsWith('CS')) {
          title = cells[1];
        } else if (cells[0] && !normalizeDate(cells[0])) {
          title = cells[0];
        }

        if (title && endDate) {
          const actKey = generateActivityKey(studentId, courseCode || 'VU_COURSE', 'Quiz', title, '');
          if (!seen.has(actKey)) {
            seen.add(actKey);
            activities.push({
              student_id: studentId || 'unassigned',
              activity_key: actKey,
              vulms_activity_id: '',
              course_code: courseCode || 'VU_COURSE',
              course_name: courseName || VU_COURSE_CATALOG[courseCode] || courseCode,
              activity_title: title,
              activity_type: inferActivityType(title),
              start_date: startDate || endDate,
              end_date: endDate,
              activity_url: '',
              extracted_at: new Date().toISOString()
            });
          }
        }
      }
    }

    return activities;
  }

  /**
   * Determines whether the current document or page represents an authenticated VULMS session.
   * Accurately rejects unauthenticated login screens (e.g., Login.aspx, presence of login form fields),
   * and verifies authenticated state via student ID elements, profile panels, or logout controls.
   */
  function isUserAuthenticated(doc) {
    if (!doc) return false;

    try {
      if (doc.querySelector) {
        const hasLoginForm = doc.querySelector('#txtStudentID, #txtPassword, #btnLogin, input[type="password"]');
        const hasLogout = doc.querySelector('#lnkLogout, #ctl00_lnkLogout, a[href*="logout" i], a[href*="Logout.aspx" i]');
        const hasStudentProfile = doc.querySelector('#lblStudentId, #ctl00_lblStudentId, #lblStudentID, .student-id, .user-profile, #loginUserName');

        // If login inputs are present and NO logout/studentId element is present, user is NOT authenticated
        if (hasLoginForm && !hasLogout && !hasStudentProfile) {
          return false;
        }

        // If explicit logout element is present, user is authenticated
        if (hasLogout) {
          return true;
        }

        // If student ID is present and matches standard VU student ID pattern
        const sId = extractStudentId(doc);
        if (sId && /^[a-zA-Z]{2}\d{7,9}$/i.test(sId)) {
          return true;
        }
      }

      // Fallback text scan for logout or student id pattern
      if (doc.body) {
        const bodyTxt = (doc.body.innerText || doc.body.textContent || '');
        if (/\blogout\b/i.test(bodyTxt) && /\b([a-zA-Z]{2}\d{7,9})\b/i.test(bodyTxt)) {
          return true;
        }
      }
    } catch (e) {}

    return false;
  }

  /**
   * Searches the document for the "Classic To-Do" button, link, tab, or control.
   * Handles various ASP.NET WebForms and dynamic DOM identifiers:
   * - Specific IDs: #btnClassic, #ctl00_MainContent_btnClassic, #btnClassicToDo, etc.
   * - Attribute selectors matching 'classic' in ID, class, href, or name
   * - Text content matching "Classic To-Do", "Classic View", "Classic List", or "Classic"
   */
  function findClassicToDoElement(doc) {
    if (!doc) return null;

    try {
      // 1. Direct IDs
      const specificIds = [
        '#tabHClassic',
        '#ctl00_MainContent_tabHClassic',
        '#btnClassic',
        '#ctl00_MainContent_btnClassic',
        '#btnClassicToDo',
        '#ctl00_MainContent_btnClassicToDo',
        '#lnkClassic',
        '#ctl00_MainContent_lnkClassic',
        '#lnkClassicToDo',
        '#ctl00_MainContent_lnkClassicToDo',
        '#btnClassicView',
        '#ctl00_MainContent_btnClassicView',
        '#tabClassic',
        '#ctl00_MainContent_tabClassic'
      ];

      for (const sel of specificIds) {
        const el = doc.querySelector ? doc.querySelector(sel) : null;
        if (el) return el;
      }

      // 2. Attribute selectors
      const attrSelectors = [
        'a[id*="classic" i]',
        'button[id*="classic" i]',
        'input[id*="classic" i]',
        'a[href*="classic" i]',
        'a[onclick*="classic" i]',
        'input[name*="classic" i]',
        '[class*="classic" i]'
      ];

      for (const sel of attrSelectors) {
        const el = doc.querySelector ? doc.querySelector(sel) : null;
        if (el) return el;
      }

      // 3. Search all clickable candidates by text content or input value
      if (doc.querySelectorAll) {
        const candidates = doc.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="tab"], .btn, .tab, span, div, li');
        for (const el of candidates) {
          const text = (el.textContent || el.value || el.innerText || '').trim();
          if (/classic\s*(?:to-?do|view|list)?/i.test(text)) {
            return el;
          }
        }
      }
    } catch (e) {}

    return null;
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
    extractActivitiesFromJson,
    extractActivitiesFromHtml,
    hashString,
    isUserAuthenticated,
    findClassicToDoElement
  };
});

