/**
 * VULMS Smart Deadline Tracker — Acceptance Test Suite
 * Validates extractor logic, date normalizer, hashing, and Apps Script upsert state machine.
 */

const extractor = require('../extension/content/extractor.js');
const mockData = require('./mock_vulms_data.json');

let passCount = 0;
let failCount = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName} - ${details}`);
    failCount++;
  }
}

console.log('\n======================================================');
console.log('🧪 RUNNING VULMS TRACKER ACCEPTANCE TESTS');
console.log('======================================================\n');

// ----------------------------------------------------
// Section 1: Date Normalization Tests
// ----------------------------------------------------
console.log('[1] Date Normalization:');
assert(extractor.normalizeDate('09-Nov-2026 23:59') === '2026-11-09', 'DD-MMM-YYYY with time format', extractor.normalizeDate('09-Nov-2026 23:59'));
assert(extractor.normalizeDate('2026-11-09') === '2026-11-09', 'ISO YYYY-MM-DD format');
assert(extractor.normalizeDate('15/12/2026') === '2026-12-15', 'DD/MM/YYYY format');
assert(extractor.normalizeDate('Nov 04, 2026 11:59 PM') === '2026-11-04', 'VULMS standard "Nov 04, 2026 11:59 PM" format');
assert(extractor.normalizeDate('60%') === null, 'Rejects percentage string "60%"');
assert(extractor.normalizeDate('60') === null, 'Rejects standalone number "60"');
assert(extractor.normalizeDate('1960-01-01') === null, 'Rejects year outside academic bounds (1960)');
assert(extractor.normalizeDate('Weightage 25%') === null, 'Rejects weightage string');

// ----------------------------------------------------
// Section 2: Course & Activity Parsing
// ----------------------------------------------------
console.log('\n[2] Course & Activity Type Parsing:');
const c1 = extractor.parseCourse('CS101 - Introduction to Computing');
assert(c1.code === 'CS101' && c1.name === 'Introduction to Computing', 'Hyphen separated course');

const c2 = extractor.parseCourse('MTH101: Calculus and Analytical Geometry');
assert(c2.code === 'MTH101' && c2.name === 'Calculus and Analytical Geometry', 'Colon separated course');

const c3 = extractor.parseCourse('CS302');
assert(c3.code === 'CS302' && c3.name === 'Digital Logic Design', 'Auto-resolves CS302 to "Digital Logic Design" via catalog');

const c4 = extractor.parseCourse('EXAMS 60%');
assert(c4.code !== 'EXAMS60', 'Rejects non-course phrase "EXAMS 60%" from matching as course code');

assert(extractor.inferActivityType('Assignment No. 2') === 'Assignment', 'Assignment inference');
assert(extractor.inferActivityType('Online Quiz 1') === 'Quiz', 'Quiz inference');
assert(extractor.inferActivityType('Semester Quiz # 01') === 'Quiz', 'Semester Quiz inference');
assert(extractor.inferActivityType('Graded Discussion Board (GDB)') === 'GDB', 'GDB inference');
assert(extractor.inferActivityType('Final Term % 60%') !== 'Final Exam', 'Rejects grading weight from Final Exam inference');

// URL Activity ID vs Course Code
assert(extractor.extractActivityIdFromUrl('https://vulms.vu.edu.pk/CourseHome.aspx?id=CS302') === '', 'Rejects course code in URL query ?id=CS302');
assert(extractor.extractActivityIdFromUrl('https://vulms.vu.edu.pk/Quiz/Start.aspx?id=8831') === '8831', 'Extracts valid numerical activity ID 8831');

// ----------------------------------------------------
// Section 2B: Official VU Email & Student Profile Tests
// ----------------------------------------------------
console.log('\n[2B] Official VU Email & Student Name Validation:');
const mockProfileDoc = {
  body: {
    innerText: `
      MUHAMMAD ABDULLAH
      bc240424582
      bc240424582mab@vu.edu.pk
      (VU Email)
      Note: For any correction or change is required in your profile information, please write to studentprofile@vu.edu.pk
    `,
    innerHTML: `<div>bc240424582mab@vu.edu.pk</div>`
  },
  querySelector: () => null
};

const extractedEmail = extractor.extractOfficialVuEmail(mockProfileDoc);
assert(extractedEmail === 'bc240424582mab@vu.edu.pk', 'Extracts exact official VU email with initials suffix (bc240424582mab@vu.edu.pk)', extractedEmail);

const profileResult = extractor.extractStudentProfile(mockProfileDoc);
assert(profileResult.studentName === 'Muhammad Abdullah', 'Extracts verified student name Muhammad Abdullah', profileResult.studentName);
assert(profileResult.studentId === 'bc240424582', 'Extracts student ID bc240424582', profileResult.studentId);
assert(profileResult.vuEmail === 'bc240424582mab@vu.edu.pk', 'Extracts vuEmail matching student profile', profileResult.vuEmail);

assert(extractor.isValidPersonName('MUHAMMAD ABDULLAH') === true, 'Validates genuine person name: MUHAMMAD ABDULLAH');
assert(extractor.isValidPersonName('G Management System') === false, 'Rejects system header: G Management System');
assert(extractor.isValidPersonName('Learning Management System') === false, 'Rejects LMS title: Learning Management System');
assert(extractor.isValidPersonName('Student Profile') === false, 'Rejects page title: Student Profile');

// ----------------------------------------------------
// Section 3: Deterministic Activity Key Tests
// ----------------------------------------------------
console.log('\n[3] Deterministic Key Hashing:');
const key1 = extractor.generateActivityKey('bc210401234', 'CS101', 'Assignment', 'Assignment No. 1', '');
const key2 = extractor.generateActivityKey('bc210401234', 'CS101', 'Assignment', 'Assignment No. 1', '');
const keyDifferentStudent = extractor.generateActivityKey('bc220499999', 'CS101', 'Assignment', 'Assignment No. 1', '');
const keyWithVulmsId = extractor.generateActivityKey('bc210401234', 'CS101', 'Assignment', 'Assignment No. 1', '10552');

assert(key1 === key2, 'Same inputs generate identical key');
assert(key1 !== keyDifferentStudent, 'Different students generate distinct keys (Student Isolation)');
assert(keyWithVulmsId === 'bc210401234_10552', 'Explicit VULMS ID takes precedence');

// ----------------------------------------------------
// Section 4: Simulated Apps Script Upsert Engine (Tests A through J)
// ----------------------------------------------------
console.log('\n[4] Acceptance Tests Matrix (Apps Script State Machine Simulation):');

// Simulation environment
class MockDatabase {
  constructor() {
    this.rows = [];
    this.sentEmails = [];
  }

  sync(payload) {
    const todayPkt = '2026-11-09';
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of payload.activities) {
      const existing = this.rows.find(r => r.activity_key === item.activity_key);

      if (!existing) {
        // Ingestion-time check
        const isPast = item.end_date < todayPkt;
        this.rows.push({
          student_id: payload.studentId,
          activity_key: item.activity_key,
          course_code: item.course_code,
          activity_title: item.activity_title,
          end_date: item.end_date,
          status: isPast ? 'overdue' : 'active',
          reminder_status: isPast ? 'skipped_past_deadline' : 'pending',
          reminder_sent_at: null
        });
        inserted++;
      } else {
        if (item.end_date !== existing.end_date) {
          const wasSent = existing.reminder_status === 'sent';
          existing.end_date = item.end_date;
          existing.status = 'active';
          existing.reminder_status = wasSent ? 'pending_extended' : 'pending';
          updated++;
        } else {
          skipped++;
        }
      }
    }

    return { inserted, updated, skipped, total: this.rows.length };
  }

  runHourlyTrigger(pktDate, pktHour) {
    if (pktHour < 12) return 0; // Gatekeeper
    let sent = 0;
    for (const row of this.rows) {
      if ((row.reminder_status === 'pending' || row.reminder_status === 'pending_extended') && row.end_date === pktDate) {
        this.sentEmails.push({ ...row, sentAtHour: pktHour });
        row.reminder_status = 'sent';
        row.reminder_sent_at = `${pktDate} ${pktHour}:00:00`;
        sent++;
      }
    }
    return sent;
  }
}

const db = new MockDatabase();
const studentA = 'bc210401234';

// Test A: First-time extraction produces exactly 1 row
const testItem1 = {
  activity_key: extractor.generateActivityKey(studentA, 'CS101', 'Assignment', 'Assignment 1', ''),
  course_code: 'CS101',
  activity_title: 'Assignment 1',
  end_date: '2026-11-09'
};
const resA = db.sync({ studentId: studentA, activities: [testItem1] });
assert(resA.inserted === 1 && db.rows.length === 1, 'Test A: First-time discovery inserts exactly 1 row');

// Test B: Repeated 5x sync produces 0 duplicates
let dupInserts = 0;
for (let i = 0; i < 5; i++) {
  const resB = db.sync({ studentId: studentA, activities: [testItem1] });
  dupInserts += resB.inserted;
}
assert(dupInserts === 0 && db.rows.length === 1, 'Test B: 5x repeated sync produces 0 duplicate rows');

// Test C: Noon Gatekeeper holds trigger before 12:00 PM
const earlyRun = db.runHourlyTrigger('2026-11-09', 11); // 11 AM
assert(earlyRun === 0 && db.sentEmails.length === 0, 'Test C1: Trigger run at 11:00 AM does not dispatch email');

// Test C2: Trigger run at 12:00 PM dispatches email
const noonRun = db.runHourlyTrigger('2026-11-09', 12); // 12:00 PM noon
assert(noonRun === 1 && db.sentEmails.length === 1 && db.rows[0].reminder_status === 'sent', 'Test C2: Trigger run at 12:00 PM dispatches email and marks row sent');

// Test E: Subsequent hourly runs never duplicate emails for the same item
const afternoonRun = db.runHourlyTrigger('2026-11-09', 13); // 1:00 PM
assert(afternoonRun === 0 && db.sentEmails.length === 1, 'Test E: Trigger run at 1:00 PM skips already sent item (0 duplicate emails)');

// Test D: Deadline extended from Nov 09 to Nov 10 updates row and reschedules reminder
const extendedItem1 = { ...testItem1, end_date: '2026-11-10' };
const resD = db.sync({ studentId: studentA, activities: [extendedItem1] });
assert(resD.updated === 1 && db.rows[0].end_date === '2026-11-10' && db.rows[0].reminder_status === 'pending_extended', 'Test D: Rescheduled end date updates row and sets pending_extended');

// Test D2: On the extended date (Nov 10) at 12:00 PM, email is dispatched
const extendedNoonRun = db.runHourlyTrigger('2026-11-10', 12);
assert(extendedNoonRun === 1 && db.sentEmails.length === 2 && db.rows[0].reminder_status === 'sent', 'Test D2: Extended deadline dispatches reminder on new due date');

// Test J: Late discovery of an already expired activity
const pastDueItem = {
  activity_key: extractor.generateActivityKey(studentA, 'ENG101', 'Assignment', 'Old Assignment', ''),
  course_code: 'ENG101',
  activity_title: 'Old Assignment',
  end_date: '2026-10-01' // in the past relative to 2026-11-09
};
const resJ = db.sync({ studentId: studentA, activities: [pastDueItem] });
const pastRow = db.rows.find(r => r.activity_title === 'Old Assignment');
assert(pastRow.reminder_status === 'skipped_past_deadline' && pastRow.status === 'overdue', 'Test J: Late discovered past-due item tagged skipped_past_deadline (no fake email)');

// Test H: Multi-student data isolation
const studentB = 'bc220555555';
const testItemStudentB = {
  activity_key: extractor.generateActivityKey(studentB, 'CS101', 'Assignment', 'Assignment 1', ''),
  course_code: 'CS101',
  activity_title: 'Assignment 1',
  end_date: '2026-11-09'
};
const resH = db.sync({ studentId: studentB, activities: [testItemStudentB] });
assert(resH.inserted === 1 && db.rows.filter(r => r.student_id === studentB).length === 1, 'Test H: Student A and Student B data strictly isolated');

// ----------------------------------------------------
// Section 5: Real-World VULMS DOM Extraction Acceptance Test
// ----------------------------------------------------
console.log('\n[5] VULMS DOM Extraction & Grading Scheme Rejection:');
const mockVulmsPage = {
  querySelectorAll: (selector) => {
    if (selector.includes('table')) {
      return [
        // Table 1: Valid To-Do Calendar Table (4 quizzes)
        {
          textContent: 'Course Title Open Date Due Date Action CS302 Semester Quiz # 01 Nov 03, 2026 12:00 AM Nov 04, 2026 11:59 PM CS302 Semester Quiz # 02 Dec 01, 2026 12:00 AM Dec 02, 2026 11:59 PM',
          querySelectorAll: (sub) => {
            if (sub === 'tr') {
              return [
                {
                  querySelectorAll: () => [
                    { textContent: 'Course' },
                    { textContent: 'Title' },
                    { textContent: 'Open Date' },
                    { textContent: 'Due Date' },
                    { textContent: 'Action' }
                  ]
                },
                {
                  querySelectorAll: () => [
                    { textContent: 'CS302', querySelector: () => null },
                    { textContent: 'Semester Quiz # 01', querySelector: () => null },
                    { textContent: 'Nov 03, 2026 12:00 AM', querySelector: () => null },
                    { textContent: 'Nov 04, 2026 11:59 PM', querySelector: () => null },
                    { textContent: '', querySelector: () => null }
                  ]
                },
                {
                  querySelectorAll: () => [
                    { textContent: 'CS302', querySelector: () => null },
                    { textContent: 'Semester Quiz # 02', querySelector: () => null },
                    { textContent: 'Dec 01, 2026 12:00 AM', querySelector: () => null },
                    { textContent: 'Dec 02, 2026 11:59 PM', querySelector: () => null },
                    { textContent: '', querySelector: () => null }
                  ]
                }
              ];
            }
            return [];
          }
        },
        // Table 2: Assessment Scheme Table (Must be rejected)
        {
          textContent: 'Assessment Scheme Weightage Final Term % 60% Mid Term % 20% Quizzes 10% Assignments 10%',
          querySelectorAll: () => []
        }
      ];
    }
    return [];
  }
};

const extractedFromMock = extractor.extractActivities(mockVulmsPage, 'bc240424582');
assert(extractedFromMock.length === 2, 'Extracts exactly 2 quizzes and 0 grading scheme items', `Extracted: ${extractedFromMock.length}`);
assert(extractedFromMock[0].course_code === 'CS302', 'Course code is CS302');
assert(extractedFromMock[0].course_name === 'Digital Logic Design', 'Auto-resolved course title to "Digital Logic Design"');
assert(extractedFromMock[0].end_date === '2026-11-04', 'Due date is 2026-11-04');
assert(extractedFromMock[0].vulms_activity_id === '', 'Does not assign CS302 as vulms_activity_id');
assert(!extractedFromMock.some(a => a.course_code.includes('EXAM') || a.activity_title.includes('%')), 'Zero grading scheme false positives extracted');

// ----------------------------------------------------
// Section 6: StudentProfile.aspx ASP.NET Form Controls & Unrendered Doc Test
// ----------------------------------------------------
console.log('\n[6] StudentProfile ASP.NET Form Controls & DOMParser Document Support:');
const mockAspnetDoc = {
  body: {
    // Note: simulating DOMParser document where innerText is undefined!
    innerText: undefined,
    textContent: 'VU Student Profile Page',
    innerHTML: '<input id="txtEmail" value="bc240424582mab@vu.edu.pk" />'
  },
  querySelectorAll: (selector) => {
    if (selector.includes('input')) {
      return [
        { id: 'txtStudentId', name: 'ctl00$txtStudentId', value: 'BC240424582', getAttribute: () => 'BC240424582' },
        { id: 'txtStudentName', name: 'ctl00$txtStudentName', value: 'Muhammad Abdullah', getAttribute: () => 'Muhammad Abdullah' },
        { id: 'txtVUEmail', name: 'ctl00$txtVUEmail', value: 'bc240424582mab@vu.edu.pk', getAttribute: () => 'bc240424582mab@vu.edu.pk' }
      ];
    }
    return [];
  },
  querySelector: () => null
};

const profileExtracted = extractor.extractStudentProfile(mockAspnetDoc);
assert(profileExtracted.studentId === 'bc240424582', 'Extracts student ID from ASP.NET form input without crashing when innerText is undefined');
assert(profileExtracted.studentName === 'Muhammad Abdullah', 'Extracts student name from ASP.NET form input');
assert(profileExtracted.vuEmail === 'bc240424582mab@vu.edu.pk', 'Extracts official VU email from ASP.NET form input');

// ----------------------------------------------------
// Section 7: FullCalendar DOM Scraper Test
// ----------------------------------------------------
console.log('\n[7] FullCalendar DOM Scraper Test:');
const mockFullCalendarDoc = {
  querySelectorAll: (selector) => {
    if (selector.includes('fc-event')) {
      const parentCell = {
        getAttribute: (attr) => (attr === 'data-date' ? '2026-11-15' : null),
        parentElement: null
      };
      return [
        {
          tagName: 'DIV',
          textContent: '11:59 PM CS201 Assignment No. 1',
          getAttribute: (attr) => (attr === 'title' ? 'CS201 Assignment No. 1 Due: 15-Nov-2026' : null),
          parentElement: parentCell,
          querySelector: (s) => (s === 'a' ? { href: 'https://vulms.vu.edu.pk/Assignment/View.aspx?id=9012' } : null)
        }
      ];
    }
    return [];
  }
};

const fcExtracted = extractor.extractActivities(mockFullCalendarDoc, 'bc240424582');
assert(fcExtracted.length === 1, 'Extracts FullCalendar event from .fc-event DOM');
assert(fcExtracted[0].course_code === 'CS201', 'FullCalendar course code parsed as CS201');
assert(fcExtracted[0].end_date === '2026-11-15', 'FullCalendar end date resolved to 2026-11-15');
assert(fcExtracted[0].vulms_activity_id === '9012', 'FullCalendar extracted activity ID 9012 from URL');

// ----------------------------------------------------
// Section 8: Home.aspx Course Dashboard Scraper Test
// ----------------------------------------------------
console.log('\n[8] Home.aspx Course Dashboard Scraper Test:');
const mockHomeCourseDoc = {
  querySelectorAll: (selector) => {
    if (selector.includes('tblCourses')) {
      return [
        {
          textContent: 'CS302 - Digital Logic Design Credit Hours: 3',
          querySelectorAll: (s) => {
            if (s.includes('Assignment')) {
              return [
                {
                  textContent: 'Assignment No. 2 (Due Date: 20-Nov-2026 23:59)',
                  href: 'https://vulms.vu.edu.pk/Assignment/Submit.aspx?id=11420',
                  parentElement: { textContent: 'Pending Submission Due: 20-Nov-2026' },
                  closest: () => ({ textContent: 'CS302 Digital Logic Design' })
                }
              ];
            }
            return [];
          }
        }
      ];
    }
    return [];
  }
};

const homeCourseExtracted = extractor.extractActivities(mockHomeCourseDoc, 'bc240424582');
assert(homeCourseExtracted.length === 1, 'Extracts activity from Home.aspx course dashboard card');
assert(homeCourseExtracted[0].course_code === 'CS302', 'Dashboard course code resolved to CS302');
assert(homeCourseExtracted[0].end_date === '2026-11-20', 'Dashboard end date resolved to 2026-11-20');
assert(homeCourseExtracted[0].activity_type === 'Assignment', 'Dashboard activity type resolved to Assignment');

// ----------------------------------------------------
// Section 9: JSON Extraction Engine (ActivityCalendar.aspx feeds)
// ----------------------------------------------------
console.log('\n[9] JSON Extraction Engine (ActivityCalendar.aspx feeds):');

// 9A: Direct JSON array
const rawJsonArray = JSON.stringify([
  {
    id: "7701",
    title: "CS101 - Quiz 1 (Lessons 1 to 15)",
    course: "CS101",
    activity: "Quiz",
    start: "2026-11-05 00:00",
    end: "2026-11-06 23:59",
    url: "/Quiz/Start.aspx?id=7701"
  }
]);

const jsonArrayActs = extractor.extractActivitiesFromJson(rawJsonArray, 'bc240424582');
assert(jsonArrayActs.length === 1, 'Parses standard JSON array from ActivityCalendar.aspx');
assert(jsonArrayActs[0].course_code === 'CS101', 'JSON course code is CS101');
assert(jsonArrayActs[0].end_date === '2026-11-06', 'JSON end date normalized to 2026-11-06');
assert(jsonArrayActs[0].vulms_activity_id === '7701', 'JSON extracted activity ID 7701');

// 9B: ASP.NET PageMethod { "d": [...] } wrapper
const rawAspnetJson = JSON.stringify({
  d: [
    {
      id: "8820",
      title: "MTH101 Graded Discussion Board",
      course: "MTH101",
      activity: "GDB",
      start: "2026-11-10",
      end: "2026-11-12 23:59"
    }
  ]
});

const aspnetJsonActs = extractor.extractActivitiesFromJson(rawAspnetJson, 'bc240424582');
assert(aspnetJsonActs.length === 1, 'Parses ASP.NET { "d": [...] } wrapped JSON feed');
assert(aspnetJsonActs[0].course_code === 'MTH101', 'ASP.NET JSON course code is MTH101');
assert(aspnetJsonActs[0].activity_type === 'GDB', 'ASP.NET JSON activity type is GDB');
assert(aspnetJsonActs[0].end_date === '2026-11-12', 'ASP.NET JSON end date is 2026-11-12');

// 9C: HTML with embedded JSON in <script> tag
const htmlWithScriptJson = `
<html>
  <body>
    <script>
      var calendarEvents = [
        {
          "id": "9933",
          "title": "CS302 Assignment 1",
          "course": "CS302",
          "activity": "Assignment",
          "due": "Nov 25, 2026 11:59 PM"
        }
      ];
    </script>
  </body>
</html>
`;

const htmlScriptActs = extractor.extractActivitiesFromHtml(htmlWithScriptJson, 'bc240424582');
assert(htmlScriptActs.length === 1, 'Extracts JSON calendar events embedded in <script> tag');
assert(htmlScriptActs[0].course_code === 'CS302', 'Script JSON course code is CS302');
assert(htmlScriptActs[0].end_date === '2026-11-25', 'Script JSON end date is 2026-11-25');

// ----------------------------------------------------
// Section 10: Authentication State & Login Lifecycle Tests
// ----------------------------------------------------
console.log('\n[10] Authentication Detection & Login Lifecycle Tests:');

// 10A: Unauthenticated Login Page (must NOT trigger fetching)
const mockLoginPage = {
  querySelector: (sel) => {
    if (sel.includes('password') || sel.includes('txtPassword') || sel.includes('btnLogin')) {
      return { id: 'txtPassword', type: 'password' };
    }
    return null;
  },
  body: { innerText: 'Virtual University Login Please enter your Student ID and Password' }
};
assert(extractor.isUserAuthenticated(mockLoginPage) === false, 'Rejects unauthenticated login page with password field (Prevents premature fetching)');

// 10B: Authenticated Homepage (Home.aspx with student ID and logout)
const mockHomePage = {
  querySelector: (sel) => {
    if (sel.includes('lblStudentId') || sel.includes('student-id')) {
      return { textContent: 'BC240424582', id: 'lblStudentId' };
    }
    if (sel.includes('logout') || sel.includes('lnkLogout')) {
      return { href: 'Logout.aspx', id: 'lnkLogout' };
    }
    return null;
  },
  body: { innerText: 'Welcome Muhammad Abdullah BC240424582 Logout Home Dashboard Courses' }
};
assert(extractor.isUserAuthenticated(mockHomePage) === true, 'Validates authenticated VULMS homepage with verified student ID and logout link');

// 10C: Logged out redirect page
const mockLoggedOutPage = {
  querySelector: (sel) => {
    if (sel.includes('txtStudentID') || sel.includes('btnLogin')) {
      return { id: 'btnLogin', value: 'Sign In' };
    }
    return null;
  },
  body: { innerText: 'You have successfully logged out of VULMS.' }
};
assert(extractor.isUserAuthenticated(mockLoggedOutPage) === false, 'Rejects logged-out redirect page (Halts fetching immediately)');

// ----------------------------------------------------
// Section 11: Classic To-Do Element Discovery Tests
// ----------------------------------------------------
console.log('\n[11] Classic To-Do Element Discovery & Triggering:');

// 11A: ASP.NET LinkButton with specific ID
const mockDocWithId = {
  querySelector: (sel) => {
    if (sel === '#ctl00_MainContent_btnClassic' || sel.includes('btnClassic')) {
      return { id: 'ctl00_MainContent_btnClassic', tagName: 'A', textContent: 'Classic To-Do' };
    }
    return null;
  },
  querySelectorAll: () => []
};
const foundById = extractor.findClassicToDoElement(mockDocWithId);
assert(foundById && foundById.id === 'ctl00_MainContent_btnClassic', 'Finds Classic To-Do by ASP.NET control ID #ctl00_MainContent_btnClassic');

// 11B: Element matching text content "Classic To-Do"
const mockDocWithText = {
  querySelector: () => null,
  querySelectorAll: () => [
    { tagName: 'A', textContent: 'Modern Calendar', href: '#' },
    { tagName: 'BUTTON', textContent: 'Classic To-Do', id: 'btnCustomView' },
    { tagName: 'A', textContent: 'Semester Schedule', href: '#' }
  ]
};
const foundByText = extractor.findClassicToDoElement(mockDocWithText);
assert(foundByText && foundByText.id === 'btnCustomView', 'Finds Classic To-Do element by text content "Classic To-Do"');

// 11C: Tab element with "Classic View"
const mockDocWithTab = {
  querySelector: () => null,
  querySelectorAll: () => [
    { tagName: 'LI', textContent: 'Calendar Grid', role: 'tab' },
    { tagName: 'LI', textContent: 'Classic View', role: 'tab', id: 'tabClassic' }
  ]
};
const foundByTab = extractor.findClassicToDoElement(mockDocWithTab);
assert(foundByTab && foundByTab.id === 'tabClassic', 'Finds Classic To-Do tab by text content "Classic View"');

// 11D: Exact real-world VULMS element <a id="tabHClassic" ...>
const mockRealVulmsDoc = {
  querySelector: (sel) => {
    if (sel === '#tabHClassic' || sel.includes('tabHClassic')) {
      return {
        id: 'tabHClassic',
        tagName: 'A',
        textContent: 'Classic To Do',
        href: "javascript:__doPostBack('ctl00$MainContent$tabHClassic','')"
      };
    }
    return null;
  },
  querySelectorAll: () => []
};
const foundRealVulms = extractor.findClassicToDoElement(mockRealVulmsDoc);
assert(foundRealVulms && foundRealVulms.id === 'tabHClassic', 'Finds real VULMS #tabHClassic Classic To Do link');


// ----------------------------------------------------
// Section 12: Silent Frame Automatic Fetching & Cache Concurrency
// ----------------------------------------------------
console.log('\n[12] Silent Frame Automatic Fetching & Cache Concurrency:');

// Simulation of the silent iframe lifecycle:
// Step 1: ActivityCalendar.aspx loads initially WITHOUT the table.
// Step 2: Triggering Classic To-Do causes the table to render.
// Step 3: Extractor captures activities automatically without opening the page in a tab.

class MockSilentFrameDocument {
  constructor() {
    this.tableRendered = false;
    this.classicClicked = false;
  }

  clickClassic() {
    this.classicClicked = true;
    this.tableRendered = true; // Simulates ASP.NET postback / UpdatePanel table injection
  }

  querySelector(sel) {
    if (sel.includes('classic') || sel.includes('btnClassic')) {
      return {
        id: 'ctl00_MainContent_btnClassic',
        textContent: 'Classic To-Do',
        click: () => this.clickClassic()
      };
    }
    return null;
  }

  querySelectorAll(sel) {
    if (sel.includes('table') && this.tableRendered) {
      return [
        {
          textContent: 'Course Title Open Date Due Date CS302 Semester Quiz # 01 Nov 03, 2026 12:00 AM Nov 04, 2026 11:59 PM CS302 Semester Quiz # 02 Dec 01, 2026 12:00 AM Dec 02, 2026 11:59 PM',
          querySelectorAll: (sub) => {
            if (sub === 'tr') {
              return [
                { querySelectorAll: () => [{ textContent: 'Course' }, { textContent: 'Title' }, { textContent: 'Open Date' }, { textContent: 'Due Date' }] },
                { querySelectorAll: () => [{ textContent: 'CS302' }, { textContent: 'Semester Quiz # 01' }, { textContent: 'Nov 03, 2026' }, { textContent: 'Nov 04, 2026' }] },
                { querySelectorAll: () => [{ textContent: 'CS302' }, { textContent: 'Semester Quiz # 02' }, { textContent: 'Dec 01, 2026' }, { textContent: 'Dec 02, 2026' }] }
              ];
            }
            return [];
          }
        }
      ];
    }
    return [];
  }
}

const mockFrame = new MockSilentFrameDocument();

// Initial check before click: table is not yet rendered
const initialActs = extractor.extractActivities(mockFrame, 'bc240424582');
assert(initialActs.length === 0, 'Silent frame initial view has 0 activities (Table not yet populated)');

// Trigger Classic To-Do click
const triggerEl = extractor.findClassicToDoElement(mockFrame);
assert(triggerEl !== null, 'Found Classic To-Do element in silent frame DOM');
triggerEl.click();
assert(mockFrame.classicClicked === true && mockFrame.tableRendered === true, 'Clicking Classic To-Do triggers table render inside silent frame');

// Check after click: table is extracted!
const postClickActs = extractor.extractActivities(mockFrame, 'bc240424582');
assert(postClickActs.length === 2, 'Extracts 2 quizzes automatically after Classic To-Do trigger without user navigating to page');
assert(postClickActs[0].course_code === 'CS302' && postClickActs[0].end_date === '2026-11-04', 'First quiz details verified');

// 12B: Cache Concurrency & Duplicate Request Prevention
class MockClientCache {
  constructor(ttlMs = 300000) {
    this.ttlMs = ttlMs;
    this.cachedData = null;
    this.lastSyncTime = 0;
    this.networkFetchCount = 0;
  }

  fetchData(isManual = false, currentTime = Date.now()) {
    const isFresh = (currentTime - this.lastSyncTime) < this.ttlMs;
    if (!isManual && isFresh && this.cachedData) {
      return { fromCache: true, data: this.cachedData };
    }

    this.networkFetchCount++;
    this.cachedData = postClickActs;
    this.lastSyncTime = currentTime;
    return { fromCache: false, data: this.cachedData };
  }
}

const clientCache = new MockClientCache();
const firstRun = clientCache.fetchData(false, 1000);
assert(firstRun.fromCache === false && clientCache.networkFetchCount === 1, 'Initial login homepage visit performs network fetch');

// User refreshes the homepage 10 seconds later:
const refreshRun = clientCache.fetchData(false, 11000);
assert(refreshRun.fromCache === true && clientCache.networkFetchCount === 1, 'Refreshing homepage within 5-min TTL uses cache (0 duplicate network requests)');

// User navigates repeatedly:
for (let i = 0; i < 4; i++) {
  clientCache.fetchData(false, 20000 + i * 1000);
}
assert(clientCache.networkFetchCount === 1, '4x repeated navigation within TTL causes 0 duplicate requests');

// User clicks Manual Sync:
const manualRun = clientCache.fetchData(true, 25000);
assert(manualRun.fromCache === false && clientCache.networkFetchCount === 2, 'Manual sync forces fresh fetch and updates cache');

console.log('\n======================================================');
console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
console.log('======================================================\n');

if (failCount > 0) {
  process.exit(1);
}

