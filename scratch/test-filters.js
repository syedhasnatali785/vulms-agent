// Import the actual functions using fs and eval to make sure we test the real source code!
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/lib/fileFilters.ts');
const tsCode = fs.readFileSync(filePath, 'utf8');

// Strip TypeScript annotations to run in Node.js
const jsCode = tsCode
  .replace(/export\s+/g, '')
  .replace(/:\s*boolean/g, '')
  .replace(/:\s*string/g, '');

// Evaluate the functions in this context
eval(jsCode);

// Test cases
const testCases = [
  // Midterm files (should match midterm, not final)
  { filename: 'CS101_mid_paper.pdf', expectMid: true, expectFinal: false },
  { filename: 'mth301 mid exam.pdf', expectMid: true, expectFinal: false },
  { filename: 'ENG201 mids.pdf', expectMid: true, expectFinal: false },
  { filename: 'cs201 mid-term.pdf', expectMid: true, expectFinal: false },
  { filename: 'CS610_MIDTERM_FILE_5_SOLVED.pdf', expectMid: true, expectFinal: false },
  { filename: 'CS504_Mid_Term_Past_Paper_2.pdf', expectMid: true, expectFinal: false },
  
  // Final term files (should match final, not midterm)
  { filename: 'MGT602_Final_Term_Short_notes.pdf', expectMid: false, expectFinal: true },
  { filename: 'MGT602-FinalTerm-Subjective.pdf', expectMid: false, expectFinal: true },
  { filename: 'MGT602_(Highlighted)_Final_Theme_8.pdf', expectMid: false, expectFinal: true },
  { filename: 'ENG201_Final_Term_Handouts.pdf', expectMid: false, expectFinal: true },
  
  // Midterm & Final mixed / ambiguous files (should match both)
  { filename: 'CS101_Mid_and_Final_Term_Papers.pdf', expectMid: true, expectFinal: true },
  
  // General / Non-term files (should match neither)
  { filename: 'AI_WhatsApp_Chatbot_PRD_v2.pdf', expectMid: false, expectFinal: false },
  { filename: 'Quiz_CS610_4.pdf', expectMid: false, expectFinal: false },
  { filename: 'MGT602_Glossary.pdf', expectMid: false, expectFinal: false },
  { filename: 'MGT602_Entreprenurship_(Handouts).pdf', expectMid: false, expectFinal: false },
  
  // False positive checks (should match neither)
  { filename: 'pyramid.pdf', expectMid: false, expectFinal: false },
  { filename: 'humidity.pdf', expectMid: false, expectFinal: false },
  { filename: 'amidst.pdf', expectMid: false, expectFinal: false },
  { filename: 'midpoint.pdf', expectMid: false, expectFinal: false },
  { filename: 'definition.pdf', expectMid: false, expectFinal: false },
  { filename: 'finals_finals.pdf', expectMid: false, expectFinal: true }
];

let failed = 0;

console.log('Running test cases...\n');
testCases.forEach((tc, idx) => {
  const actualMid = isMidtermFile(tc.filename);
  const actualFinal = isFinalTermFile(tc.filename);
  
  const midPassed = actualMid === tc.expectMid;
  const finalPassed = actualFinal === tc.expectFinal;
  
  if (midPassed && finalPassed) {
    console.log(`[PASS] "${tc.filename}" -> mid: ${actualMid}, final: ${actualFinal}`);
  } else {
    failed++;
    console.error(`[FAIL] "${tc.filename}"`);
    if (!midPassed) console.error(`  Expected isMidtermFile to be ${tc.expectMid}, got ${actualMid}`);
    if (!finalPassed) console.error(`  Expected isFinalTermFile to be ${tc.expectFinal}, got ${actualFinal}`);
  }
});

console.log(`\nTests completed: ${testCases.length - failed}/${testCases.length} passed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed successfully!');
  process.exit(0);
}
