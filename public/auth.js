/* Sign-in screen. Loaded before app.js, which calls showAuth when the server asks for a sign-in. */
function showAuth() {
  const dialog = document.getElementById('authDialog');
  if (!dialog.open) dialog.showModal();
}

function setAuthMode(invite) {
  document.getElementById('signInForm').hidden = invite;
  document.getElementById('inviteForm').hidden = !invite;
  document.getElementById('authError').textContent = '';
  document.getElementById('authTitle').textContent = invite ? 'Join in' : 'Sign in';
  document.getElementById(invite ? 'inviteCode' : 'signInName').focus();
}

async function submitAuth(event, url, fields) {
  event.preventDefault();
  const error = document.getElementById('authError');
  const button = event.target.querySelector('button[type="submit"]');
  error.textContent = '';
  button.disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not reach the server.');
    // Reloading drops the password fields and starts the app as the signed-in person.
    location.reload();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('signInForm').addEventListener('submit', (event) => {
  submitAuth(event, '/api/login', {
    name: document.getElementById('signInName').value,
    password: document.getElementById('signInPassword').value,
  });
});
document.getElementById('inviteForm').addEventListener('submit', (event) => {
  submitAuth(event, '/api/claim', {
    code: document.getElementById('inviteCode').value,
    password: document.getElementById('invitePassword').value,
  });
});
document.getElementById('useInvite').addEventListener('click', () => setAuthMode(true));
document.getElementById('useSignIn').addEventListener('click', () => setAuthMode(false));
// Everything is behind sign-in, so this screen can't be dismissed.
document.getElementById('authDialog').addEventListener('cancel', (event) => event.preventDefault());
