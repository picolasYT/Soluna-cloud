// ===== Initialize All Functionality =====
document.addEventListener('DOMContentLoaded', function() {
  initScrollReveal();
  initParallaxEffects();
  initSmoothScroll();
  initMobileMenu();
  initCounterAnimations();
  initModal();
});

// ===== Scroll Reveal Animation =====
function initScrollReveal() {
  const elements = document.querySelectorAll('.animate-in');
  
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        revealObserver.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  };
  
  elements.forEach((el, index) => {
    el.style.animationDelay = `${0.1 * index}s`;
    el.style.animationPlayState = 'paused';
    revealObserver.observe(el);
  });
}

// ===== Parallax Effects =====
function initParallaxEffects() {
  const floatingCat = document.querySelector('.floating-cat');
  
  if (floatingCat) {
    document.addEventListener('mousemove', (e) => {
      const mouseX = e.clientX / window.innerWidth - 0.5;
      const mouseY = e.clientY / window.innerHeight - 0.5;
      
      const xRotation = mouseY * 10;
      const yRotation = mouseX * -10;
      
      floatingCat.style.transform = `perspective(1000px) rotateX(${xRotation}deg) rotateY(${yRotation}deg)`;
    });
    
    // Reset on mouse leave
    floatingCat.addEventListener('mouseleave', () => {
      floatingCat.style.transform = 'perspective(1000px) rotateX(0) rotateY(0)';
    });
  }
}

// ===== Smooth Scroll =====
function initSmoothScroll() {
  const links = document.querySelectorAll('a[href^="#"]');
  
  links.forEach(link => {
    link.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      
      if (targetId === '#') return;
      
      const targetElement = document.querySelector(targetId);
      if (targetElement) {
        e.preventDefault();
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

// ===== Mobile Menu =====
function initMobileMenu() {
  const menuToggle = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  
  if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', function() {
      navLinks.classList.toggle('active');
    });
    
    // Close menu when a link is clicked
    const links = navLinks.querySelectorAll('a');
    links.forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('active');
      });
    });
  }
}

// ===== Counter Animations for Stats =====
function initCounterAnimations() {
  const statElements = document.querySelectorAll('.card-stats span');
  
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const target = entry.target;
        const isPercentage = target.textContent.includes('%');
        
        let finalValue;
        if (isPercentage) {
          finalValue = parseInt(target.textContent);
        } else {
          // Extract number from text like "12-16 años" or "3-5 kg"
          const numbers = target.textContent.match(/\d+/g);
          if (numbers) {
            finalValue = parseInt(numbers[0]);
          } else {
            return;
          }
        }
        
        if (finalValue) {
          animateCounter(target, finalValue);
        }
        counterObserver.unobserve(target);
      }
    });
  }, {
    threshold: 0.5
  });
  
  statElements.forEach(el => counterObserver.observe(el));
}

function animateCounter(element, targetValue) {
  let currentValue = 0;
  const duration = 1000;
  const startTime = performance.now();
  
  function updateCounter(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Easing function
    const easedProgress = 1 - Math.pow(1 - progress, 3);
    
    currentValue = Math.floor(targetValue * easedProgress);
    element.textContent = currentValue;
    
    if (progress < 1) {
      requestAnimationFrame(updateCounter);
    } else {
      // Set final value with unit
      const originalText = element.getAttribute('data-original');
      if (originalText) {
        element.textContent = originalText;
      }
    }
  }
  
  requestAnimationFrame(updateCounter);
}

// ===== Modal Functionality =====
function initModal() {
  // Sample cat data for the modals
  const catData = {
    1: {
      name: "Gato Persa",
      scientificName: "Felis catus",
      origin: "Persia (Iran)",
      lifespan: "12-16 años",
      weight: "3-5 kg",
      temperament: "Dulce y tranquilo",
      description: "Conocido por su pelaje largo y lujoso y su rostro plano. Son gatos muy afectuosos y tranquilos que disfrutan de la compañía humana.",
      image: "https://images.unsplash.com/photo-1514854111513-2229f0f8d4f1?w=800&h=600&fit=crop"
    },
    2: {
      name: "Gato Siamés",
      scientificName: "Felis catus",
      origin: "Tailandia",
      lifespan: "15-20 años",
      weight: "3-4.5 kg",
      temperament: "Vocal y juguetón",
      description: "Famoso por su pelaje corto, puntos oscuros y ojos azul intensos. Son gatos muy inteligentes y comunicativos que forman fuertes lazos con sus dueños.",
      image: "https://images.unsplash.com/photo-1552196532-e3cbf0e8d42b?w=800&h=600&fit=crop"
    },
    3: {
      name: "Maine Coon",
      scientificName: "Felis catus",
      origin: "Estados Unidos (Maine)",
      lifespan: "10-13 años",
      weight: "5.9-8 kg",
      temperament: "Amigable y sociable",
      description: "El gato doméstico más grande del mundo. Destacan por su pelaje denso, bigotes largos y personalidad amigable. Son excelentes con familias y otros animales.",
      image: "https://images.unsplash.com/photo-1517248135407-8e361ba930bf?w=800&h=600&fit=crop"
    },
    4: {
      name: "Gato Bengala",
      scientificName: "Felis catus",
      origin: "Asiático/EE. UU.",
      lifespan: "12-16 años",
      weight: "3.6-6.8 kg",
      temperament: "Energético y activo",
      description: "Resultante del cruce entre gatos domésticos y leopardo de nieve asiático. Poseen un pelaje salvaje con patrones de rosetas y manchas. Requieren mucha actividad y estimulación.",
      image: "https://images.unsplash.com/photo-1566173955602-944704c887e6?w=800&h=600&fit=crop"
    },
    5: {
      name: "Ragdoll",
      scientificName: "Felis catus",
      origin: "California, EE. UU.",
      lifespan: "12-15 años",
      weight: "3.5-7 kg",
      temperament: "Relajado y afectuoso",
      description: "Conocido por volverse flácido como un muñeco de trapo al ser sostenido. Tienen ojos azules y pelaje semilargo. Son extremadamente tiernos y disfrutan siendo sostenidos.",
      image: "https://images.unsplash.com/photo-1589560009591-fc817a2f89c1?w=800&h=600&fit=crop"
    },
    6: {
      name: "Sphynx",
      scientificName: "Felis catus",
      origin: "Canadá",
      lifespan: "10-15 años",
      weight: "2.5-4 kg",
      temperament: "Juguetón y social",
      description: "Gato desnudo natural, conocido por su piel arrugada y calidez al tacto. Requieren cuidados especiales de piel y protección solar. Son muy afectuosos y les gusta el calor.",
      image: "https://images.unsplash.com/photo-1598764067315-8f421618e2b8?w=800&h=600&fit=crop"
    }
  };
  
  // Open modal function
  window.showCatInfo = function(catId) {
    const data = catData[catId];
    if (!data) return;
    
    const modal = document.getElementById('cat-modal');
    const modalImage = document.getElementById('modal-image');
    const modalTitle = document.getElementById('modal-title');
    const modalSpecs = document.getElementById('modal-specs');
    
    modalImage.src = data.image;
    modalTitle.textContent = data.name;
    
    // Build specs HTML
    modalSpecs.innerHTML = `
      <h4>Información Específica</h4>
      <ul>
        <li><strong>Nombre científico:</strong> ${data.scientificName}</li>
        <li><strong>Origen:</strong> ${data.origin}</li>
        <li><strong>Longevidad:</strong> ${data.lifespan}</li>
        <li><strong>Peso:</strong> ${data.weight}</li>
        <li><strong>Temperamento:</strong> ${data.temperament}</li>
      </ul>
    `;
    
    modal.classList.add('active');
    document.body.style.overflow = 'hidden'; // Prevent scrolling
  };
  
  // Close modal function
  const modal = document.getElementById('cat-modal');
  const modalClose = document.querySelector('.modal-close');
  
  if (modalClose) {
    modalClose.addEventListener('click', closeModal);
  }
  
  // Close when clicking outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  function closeModal() {
    modal.classList.remove('active');
    document.body.style.overflow = ''; // Re-enable scrolling
  }
}