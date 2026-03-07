window.BusinessOSPanels = window.BusinessOSPanels || {};

window.BusinessOSPanels['salon-appointments-panel'] = async function renderSalonAppointments(container) {
  container.innerHTML = '<p>Loading salon appointments...</p>';

  try {
    const response = await fetch('/api/modules/salon-module/appointments?limit=8');
    const items = await response.json();

    const rows = items
      .map((item) => {
        const time = item.start_at ? new Date(item.start_at).toLocaleString() : 'TBD';
        return `<li><strong>${item.appointment || 'Appointment'}</strong> <span>${time}</span></li>`;
      })
      .join('');

    container.innerHTML = `
      <div class="panel-body">
        <button id="newSalonBooking">Quick Book</button>
        <ul>${rows || '<li>No appointments yet</li>'}</ul>
      </div>
    `;

    const button = container.querySelector('#newSalonBooking');
    button?.addEventListener('click', async () => {
      const now = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await fetch('/api/modules/salon-module/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appointment: 'Walk-in Booking',
          start_at: now,
          status: 'booked'
        })
      });

      renderSalonAppointments(container);
    });
  } catch (error) {
    container.innerHTML = `<p>Failed to load panel: ${error.message}</p>`;
  }
};
