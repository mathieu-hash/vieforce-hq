// VieForce HQ — Chart.js Helpers

var HQ_CHART_COLORS = {
  navy: '#004D71',
  blue: '#00A6CE',
  green: '#95C93D',
  gold: '#F1B11D',
  orange: '#F58320',
  pink: '#E21B90',
  gridColor: 'rgba(0,0,0,0.06)',
  fontFamily: "'Montserrat', sans-serif"
};

// Set Chart.js defaults
Chart.defaults.font.family = HQ_CHART_COLORS.fontFamily;
Chart.defaults.font.size = 12;
Chart.defaults.color = '#666';
Chart.defaults.plugins.legend.display = false;

function createBarChart(canvasId, labels, datasets, options) {
  var ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: datasets },
    options: Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1 } },
      scales: {
        y: { beginAtZero: true, grid: { color: HQ_CHART_COLORS.gridColor } },
        x: { grid: { display: false } }
      }
    }, options || {})
  });
}

function createLineChart(canvasId, labels, datasets, options) {
  var ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1 } },
      scales: {
        y: { beginAtZero: true, grid: { color: HQ_CHART_COLORS.gridColor } },
        x: { grid: { display: false } }
      },
      elements: { line: { tension: 0.3 }, point: { radius: 4 } }
    }, options || {})
  });
}

function createDoughnutChart(canvasId, labels, data, colors) {
  var ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: colors || [
          HQ_CHART_COLORS.navy,
          HQ_CHART_COLORS.blue,
          HQ_CHART_COLORS.green,
          HQ_CHART_COLORS.gold,
          HQ_CHART_COLORS.orange,
          HQ_CHART_COLORS.pink
        ]
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { padding: 16, font: { size: 11 } }
        }
      }
    }
  });
}

function formatCurrency(n) {
  if (n == null) return '₱0';
  n = parseFloat(n);
  if (n >= 1000000) return '₱' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '₱' + (n / 1000).toFixed(0) + 'K';
  return '₱' + n.toFixed(0);
}

function formatNumber(n) {
  if (n == null) return '0';
  return parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function formatPct(n) {
  if (n == null) return '0%';
  return parseFloat(n).toFixed(1) + '%';
}
