import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function useRouteFocus() {
  const location = useLocation();

  useEffect(() => {
    // WCAG 2.4.3: Focus Order & Context Management
    // Find the primary h1 and shift focus to it
    const heading = document.querySelector('h1');
    if (heading) {
      if (!heading.hasAttribute('tabIndex')) {
        heading.setAttribute('tabIndex', '-1');
      }
      heading.focus();
    }
  }, [location.pathname]);
}
