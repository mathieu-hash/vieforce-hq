var HQ_SUPABASE_URL = 'https://yolxcmeoovztuindrglk.supabase.co';
var HQ_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvbHhjbWVvb3Z6dHVpbmRyZ2xrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MzAwMjksImV4cCI6MjA5MTEwNjAyOX0.uTXWaYLKjFCQv6MLcwQT6SjjmVum0hBiALvYMyG3OI0';
window.HQ_SUPABASE_URL = HQ_SUPABASE_URL;
window.HQ_SUPABASE_KEY = HQ_SUPABASE_KEY;
// Match VieForce Patrol: PKCE + manual ?code= exchange on index.html. Without this, some
// bundles default flows can combine badly with redirect allow-list and Supabase falls back
// to Site URL (Patrol) after Google.
var supabaseClient = window.supabase.createClient(HQ_SUPABASE_URL, HQ_SUPABASE_KEY, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'vfq-hq-supabase-auth'
  }
});
window.supabaseClient = supabaseClient;
