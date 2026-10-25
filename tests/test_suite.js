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

console.log('\n======================================================');
console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
console.log('======================================================\n');

if (failCount > 0) {
  process.exit(1);
}
