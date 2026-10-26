const ext = require('../extension/content/extractor.js');

const html = `
<table class="table">
  <tr><th>Course</th><th>Title</th><th>Open Date</th><th>Due Date</th><th>Action</th></tr>
  <tr>
    <td>CS302</td>
    <td>Semester Quiz # 01</td>
    <td>Nov 03, 2026 12:00 AM</td>
    <td>Nov 04, 2026 11:59 PM<br>10 days left.</td>
    <td></td>
  </tr>
  <tr>
    <td>CS302</td>
    <td>Semester Quiz # 02</td>
    <td>Dec 01, 2026 12:00 AM</td>
    <td>Dec 02, 2026 11:59 PM</td>
    <td></td>
  </tr>
  <tr>
    <td>CS302</td>
    <td>Semester Quiz # 03</td>
    <td>Dec 22, 2026 12:00 AM</td>
    <td>Dec 23, 2026 11:59 PM</td>
    <td></td>
  </tr>
  <tr>
    <td>CS302</td>
    <td>Semester Quiz # 04</td>
    <td>Jan 06, 2027 12:00 AM</td>
    <td>Jan 07, 2027 11:59 PM</td>
    <td></td>
  </tr>
</table>
`;

const res = ext.extractActivitiesFromHtml(html, 'bc240424582');
console.log('Result count:', res.length);
console.log(JSON.stringify(res, null, 2));
