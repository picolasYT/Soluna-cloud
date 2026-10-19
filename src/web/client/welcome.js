const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); } }, { threshold: .08 }) : null;
for (const element of document.querySelectorAll('.reveal')) { if (observer) { element.classList.add('will-reveal'); observer.observe(element); } }
fetch('/api/account/me').then((r) => r.ok ? r.json() : null).then((data) => {
  if (!data) return;
  const target = data.user ? '/app' : data.registration ? '/register' : '/login';
  for (const id of ['welcome-start', 'welcome-bottom']) document.getElementById(id).href = target;
  if (data.user) { const enter = document.getElementById('welcome-enter'); enter.href = '/app'; enter.textContent = 'Ir a mi espacio ↗'; }
  if (data.user?.isAdmin) document.getElementById('welcome-admin').hidden = false;
}).catch(() => {});
