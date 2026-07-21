const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const envPath = path.join(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value.trim();
  }
});

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkReviewsTable() {
  console.log('Testing query on "reviews" table...');
  const { data, error } = await supabase.from('reviews').select('*').limit(1);
  if (error) {
    console.log('"reviews" table error:', error.message);
  } else {
    console.log('"reviews" table exists! Data:', data);
  }

  console.log('Testing query on "current_reviews" table...');
  const { data: data2, error: error2 } = await supabase.from('current_reviews').select('*').limit(1);
  if (error2) {
    console.log('"current_reviews" table error:', error2.message);
  } else {
    console.log('"current_reviews" table exists! Data:', data2);
  }

  console.log('Testing query on "paper_reviews" table...');
  const { data: data3, error: error3 } = await supabase.from('paper_reviews').select('*').limit(1);
  if (error3) {
    console.log('"paper_reviews" table error:', error3.message);
  } else {
    console.log('"paper_reviews" table exists! Data:', data3);
  }
}

checkReviewsTable();
