// Admin Navigation Guard
// - Visit any dashboard with ?admin in the URL to enable navigation (persists via cookie)
// - Shared visitors see no navigation links
// - Tommy can also press Ctrl+Shift+H to go to All Dashboards
(function(){
  const isAdmin = document.cookie.includes('dashboard_admin=1');
  const urlHasAdmin = window.location.search.includes('admin');
  
  // Set admin cookie if ?admin is in URL (lasts 1 year)
  if(urlHasAdmin && !isAdmin){
    document.cookie = 'dashboard_admin=1; path=/; max-age=31536000; SameSite=Lax';
    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('admin');
    window.history.replaceState({}, '', url.pathname);
  }
  
  const showNav = isAdmin || urlHasAdmin;
  
  // Hide or show back links
  document.addEventListener('DOMContentLoaded', function(){
    const backLinks = document.querySelectorAll('.back, [href="../"]');
    backLinks.forEach(el => {
      if(!showNav) el.style.display = 'none';
    });
  });
  
  // Keyboard shortcut: Ctrl+Shift+H → All Dashboards (works for admin only)
  document.addEventListener('keydown', function(e){
    if(e.ctrlKey && e.shiftKey && e.key === 'H'){
      if(showNav) window.location.href = '../';
    }
  });
})();
