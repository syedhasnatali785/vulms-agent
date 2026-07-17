const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@supabase/supabase-js');

// Load env variables from current directory
loadEnvConfig(process.cwd());

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing Supabase configuration variables in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function run() {
  const number = process.argv[2];
  if (!number) {
    console.log("Usage: node scratch/add_admin.js <phone_number>");
    console.log("Example: node scratch/add_admin.js 923001234567");
    process.exit(1);
  }

  console.log(`Setting ${number} as an admin...`);

  const { data, error } = await supabase
    .from('users')
    .upsert({ 
      phone_number: number.trim(), 
      is_admin: true 
    })
    .select();

  if (error) {
    console.error("❌ Error registering admin:", error.message || error);
  } else {
    console.log("✅ Successfully registered admin number in Supabase!");
    console.log("Record:", data);
  }
}

run();
