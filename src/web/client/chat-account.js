// Legacy single-user servers do not have this endpoint and keep their UI.
fetch('/api/account/me').then((response) => response.ok ? response.json() : null).then((data) => {
  if (!data) return;
  if (!data.user) { location.replace('/login'); return; }
  const user = data.user;
  const profile = document.querySelector('.profile-copy');
  if (profile) { profile.querySelector('strong').textContent = user.username; profile.querySelector('small').textContent = user.isAdmin ? 'Administrador' : 'Mi cuenta'; }
  const avatar = document.querySelector('.profile-avatar');
  if (avatar) avatar.textContent = user.username[0].toUpperCase();
  const footer = document.querySelector('.sidebar-footer');
  const actions = document.createElement('div'); actions.className = 'account-actions';
  if (user.isAdmin) { const admin = document.createElement('a'); admin.href = '/admin'; admin.textContent = 'Administrar ↗'; actions.append(admin); }
  const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = 'Cerrar sesión';
  logout.addEventListener('click', async () => { logout.disabled = true; try { const response = await fetch('/api/account/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error(); try { sessionStorage.removeItem('soluna-cloud-token'); } catch {} location.replace('/'); } catch { logout.disabled = false; logout.textContent = 'Reintentar cierre de sesión'; } });
  actions.append(logout); footer?.append(actions);
  document.querySelector('#settings-note').textContent = 'Tus claves se guardan en tu cuenta. El administrador puede administrarlas desde su panel.';
  showAnnouncement();
}).catch(() => {});

async function showAnnouncement() {
  const area = document.querySelector('.work-area');
  if (!area) return;
  try {
    const response = await fetch('/api/account/announcement', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!response.ok) return;
    const { announcement } = await response.json();
    if (!announcement) return;
    const card = document.createElement('section');
    card.className = 'release-announcement';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-label', 'Novedades de Soluna Cloud');
    const label = document.createElement('span');
    label.className = 'release-label'; label.textContent = 'NUEVA ACTUALIZACIÓN';
    const title = document.createElement('h2'); title.textContent = announcement.title;
    const summary = document.createElement('p'); summary.textContent = announcement.summary;
    const list = document.createElement('ul');
    for (const change of announcement.changes) {
      const item = document.createElement('li'); item.textContent = change; list.append(item);
    }
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'btn release-dismiss'; close.textContent = 'Entendido';
    close.addEventListener('click', () => {
      card.remove();
      document.querySelector('#composer-input')?.focus({ preventScroll: true });
    });
    card.append(label, title, summary, list, close);
    area.prepend(card);
  } catch { /* An announcement must never prevent using the chat. */ }
}
