const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); } }, { threshold: .08 }) : null;
for (const element of document.querySelectorAll('.reveal')) { if (observer) { element.classList.add('will-reveal'); observer.observe(element); } }
fetch('/api/account/me').then((r) => r.ok ? r.json() : null).then((data) => {
  if (!data) return;
  const target = data.user ? '/app' : data.registration ? '/register' : '/login';
  for (const id of ['welcome-start', 'welcome-bottom']) document.getElementById(id).href = target;
  if (data.user) { const enter = document.getElementById('welcome-enter'); enter.href = '/app'; enter.textContent = 'Ir a mi espacio ↗'; }
  if (data.user?.isAdmin) document.getElementById('welcome-admin').hidden = false;
}).catch(() => {});

// Product demo tabs: keyboard and pointer access share one selected state.
function initializeDemoTabs(root = document) {
  const tabs = Array.from(root.querySelectorAll('.demo-tabs [role="tab"]'));
  const selectTab = (selected) => {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = root.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[index]);
      tabs[index].focus();
    });
  }
}
initializeDemoTabs();
