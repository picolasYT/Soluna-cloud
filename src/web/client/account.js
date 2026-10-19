const $ = (selector) => document.querySelector(selector);
async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && location.pathname === '/admin') location.replace('/login');
    throw new Error(data.error || 'No se pudo completar la solicitud.');
  }
  return data;
}
const form = $('#account-form');
if (form) {
  const register = location.pathname === '/register';
  $('#auth-title').textContent = register ? 'Hacé lugar a tu idea.' : 'Qué bueno verte.';
  $('#auth-description').textContent = register ? 'Creá tu cuenta y empezá a construir con Soluna.' : 'Ingresá para volver a tu espacio.';
  $('#account-submit').textContent = register ? 'Crear mi cuenta →' : 'Entrar a mi espacio →';
  $('#confirm-field').hidden = !register;
  $('#password-confirm').required = register;
  $('#signup-note').hidden = !register;
  $('#password').autocomplete = register ? 'new-password' : 'current-password';
  if (register) { $('#password').minLength = 10; $('#password').placeholder = 'Al menos 10 caracteres'; }
  const switchLink = document.createElement('a');
  switchLink.href = register ? '/login' : '/register';
  switchLink.textContent = register ? 'Iniciá sesión' : 'Creá una cuenta';
  $('#auth-switch').append(register ? '¿Ya tenés cuenta? ' : '¿Primera vez por acá? ', switchLink);
  $('#password-toggle').addEventListener('click', () => {
    const showing = $('#password').type === 'password';
    $('#password').type = showing ? 'text' : 'password';
    $('#password-toggle').textContent = showing ? 'Ocultar' : 'Ver';
    $('#password-toggle').setAttribute('aria-label', showing ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#account-error');
    error.textContent = '';
    if (register && $('#password').value !== $('#password-confirm').value) { error.textContent = 'Las contraseñas no coinciden.'; return; }
    const button = $('#account-submit');
    const label = button.textContent;
    button.disabled = true; button.textContent = register ? 'Creando tu espacio…' : 'Ingresando…';
    try {
      await request(`/api/account/${register ? 'register' : 'login'}`, { username: $('#username').value.trim(), password: $('#password').value });
      location.replace('/app');
    } catch (problem) { error.textContent = problem.message; button.disabled = false; button.textContent = label; }
  });
  request('/api/account/me').then((data) => {
    if (data.user) location.replace('/app');
    if (!data.registration && !register) $('#auth-switch').hidden = true;
    if (!data.registration && register) { $('#account-error').textContent = 'El registro está deshabilitado. Iniciá sesión con tu cuenta.'; $('#account-submit').disabled = true; }
  }).catch(() => {});
}
if ($('#admin-users')) {
  let overview = { users: [], keys: [] };
  const status = $('#admin-status');
  const text = (tag, value) => { const element = document.createElement(tag); element.textContent = value; return element; };
  const button = (label, action) => { const item = text('button', label); item.className = 'button'; item.type = 'button'; item.addEventListener('click', async () => { item.disabled = true; status.textContent = ''; try { await action(); } catch (error) { status.textContent = error.message; } finally { item.disabled = false; } }); return item; };
  function renderKeys() {
    const list = $('#admin-keys'); list.replaceChildren();
    const term = $('#admin-search').value.trim().toLocaleLowerCase();
    const keys = overview.keys.filter((item) => `${item.username} ${item.provider}`.toLocaleLowerCase().includes(term));
    for (const key of keys) {
      const row = text('article', ''); row.className = 'admin-row';
      const info = text('div', ''); info.append(text('strong', key.username), text('small', key.provider));
      const actions = text('div', ''); actions.className = 'row-actions';
      actions.append(button('Revelar', async () => {
        const data = await request('/api/admin/keys/reveal', { userId: key.userId, provider: key.provider, id: key.id });
        $('#reveal-owner').textContent = `${key.username} · ${key.provider}`;
        $('#revealed-key').value = data.key;
        $('#reveal-dialog').showModal();
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => $('#reveal-dialog').close(), 20000);
      }), button('Eliminar', async () => {
        if (!confirm(`¿Eliminar ${key.label.toLowerCase()} de ${key.provider} para ${key.username}?`)) return;
        await request('/api/admin/keys', { userId: key.userId, provider: key.provider, id: key.id, action: 'remove' });
        await refresh();
      }));
      row.append(info, text('code', key.masked), actions); list.append(row);
    }
    if (!keys.length) { const empty = text('p', 'No hay claves para mostrar.'); empty.className = 'empty-list'; list.append(empty); }
  }
  let revealTimer;
  $('#reveal-dialog').addEventListener('close', () => { clearTimeout(revealTimer); $('#revealed-key').value = ''; });
  document.addEventListener('visibilitychange', () => { if (document.hidden && $('#reveal-dialog').open) $('#reveal-dialog').close(); });
  async function refresh() {
    overview = await request('/api/admin/overview');
    $('#stat-users').textContent = String(overview.users.length);
    $('#stat-keys').textContent = String(overview.keys.length);
    $('#admin-users').replaceChildren();
    const selected = $('#admin-key-user').value;
    $('#admin-key-user').replaceChildren();
    for (const user of overview.users) {
      const row = text('article', ''); row.className = 'admin-row';
      const info = text('div', ''); info.append(text('strong', user.username), text('small', user.isAdmin ? 'Administrador' : user.disabled ? 'Cuenta deshabilitada' : 'Cuenta activa'));
      row.append(info);
      if (!user.isAdmin) row.append(button(user.disabled ? 'Habilitar' : 'Deshabilitar', async () => { await request('/api/admin/user', { userId: user.id, disabled: !user.disabled }); await refresh(); }));
      $('#admin-users').append(row);
      if (!user.disabled) { const option = text('option', user.username); option.value = user.id; $('#admin-key-user').append(option); }
    }
    if ([...$('#admin-key-user').options].some((option) => option.value === selected)) $('#admin-key-user').value = selected;
    renderKeys();
  }
  $('#admin-search').addEventListener('input', renderKeys);
  $('#admin-refresh').addEventListener('click', () => refresh().catch((error) => { status.textContent = error.message; }));
  $('#account-logout').addEventListener('click', async () => { try { await request('/api/account/logout', {}); location.replace('/'); } catch (error) { status.textContent = error.message; } });
  $('#admin-add-key').addEventListener('submit', async (event) => {
    event.preventDefault(); const submit = event.submitter; submit.disabled = true; status.textContent = '';
    try { await request('/api/admin/keys', { userId: $('#admin-key-user').value, provider: $('#admin-key-provider').value, keys: [$('#admin-key-value').value.trim()] }); $('#admin-key-value').value = ''; await refresh(); status.textContent = 'Clave guardada.'; }
    catch (error) { status.textContent = error.message; } finally { submit.disabled = false; }
  });
  Promise.all([refresh(), request('/api/config').then((data) => {
    for (const provider of data.providers.filter((item) => item.requiresKey)) { const option = text('option', provider.label); option.value = provider.id; $('#admin-key-provider').append(option); }
  })]).catch((error) => { status.textContent = error.message; });
}
