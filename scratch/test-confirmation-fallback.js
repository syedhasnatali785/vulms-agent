// Simple mock script to verify confirmation regex and course code extraction.
const CONVERSATIONAL_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'hlo', 'hy', 'assalam', 'o', 'alaikum', 'aoa', 'ws', 'salam',
  'ok', 'okay', 'yes', 'no', 'yep', 'nope', 'g', 'ji', 'haan', 'fine',
  'thanks', 'thank', 'thankyou', 'welcome',
  'please', 'pls', 'help', 'info', 'test', 'status',
  'admin', 'agent', 'bot', 'good', 'morning', 'afternoon', 'evening'
]);

function isConfirmationMessage(text) {
  const clean = text.toLowerCase().trim();
  // Match standard Roman Urdu/English affirmative words/phrases
  const confirmRegex = /^(yes|ok|okay|yep|yup|sure|please|pls|g|ji|haan|han|haaan|kar\s*do|krdo|kro|haji|do\s*it|sahi|bilkul|go\s*ahead|confirm)$/i;
  
  if (confirmRegex.test(clean)) return true;
  
  // If it's a short sentence containing confirmation keywords
  if (clean.length < 20) {
    const hasKeyword = /\b(yes|ok|okay|please|pls|haan|han|ji|g|kar\s*do|krdo|confirm|bhej\s*do|bhejdo|check)\b/i.test(clean);
    // Exclude negative words just in case
    const hasNegative = /\b(no|not|nah|dont|don't|nahi|naa|na)\b/i.test(clean);
    return hasKeyword && !hasNegative;
  }
  
  return false;
}

function extractCourseCodes(text) {
  const matches = text.match(/\b([A-Z]{2,4})\s*(\d{3,4}[A-Z]?)\b/gi) || [];
  const seen = new Set();
  const codes = [];
  for (const m of matches) {
    const normalised = m.replace(/\s+/g, '').toUpperCase();
    if (!seen.has(normalised)) { seen.add(normalised); codes.push(normalised); }
  }
  return codes;
}

// Test cases
const testInputs = [
  { text: 'yes', expected: true },
  { text: 'ok', expected: true },
  { text: 'haan search krdo', expected: true },
  { text: 'g bhej do', expected: true },
  { text: 'ji', expected: true },
  { text: 'please send', expected: true },
  { text: 'no thanks', expected: false },
  { text: 'dont send', expected: false },
  { text: 'CS302 ki books', expected: false },
];

console.log('--- Testing Confirmation Detection ---');
for (const test of testInputs) {
  const res = isConfirmationMessage(test.text);
  console.log(`Input: "${test.text}" | Expected: ${test.expected} | Got: ${res} | Result: ${res === test.expected ? 'PASS' : 'FAIL'}`);
}

console.log('\n--- Testing Course Code Extraction ---');
const botMessages = [
  'Sorry, no files found for "cs302".',
  '❌ "CS302" ke liye koi file nahi mili. please @all "CS302" try kre is se apko is subject ki tamam files mil jainge.',
  '❌ Koi file nahi mili: "MTH101"',
  'Sorry, no files found for "EDU303, CS101".'
];

for (const msg of botMessages) {
  const codes = extractCourseCodes(msg);
  console.log(`Bot message: "${msg}" -> Extracted: ${JSON.stringify(codes)}`);
}
