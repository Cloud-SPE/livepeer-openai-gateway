/**
 * Server-rendered HTML for the operator dashboard. Plain template
 * strings — no SSR framework, no React, no Lit. Vanilla TS only, by
 * exec-plan 0025 design choice.
 */

export interface DashboardSnapshot {
  build: { version: string; nodeVersion: string; environment: string };
  payerDaemon: { healthy: boolean };
  nodes: Array<{
    id: string;
    url: string;
    status: 'healthy' | 'degraded' | 'circuit_broken';
  }>;
}

export function renderDashboardHtml(snap: DashboardSnapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>livepeer-bridge operator dashboard</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
<header>
  <h1>livepeer-bridge operator dashboard</h1>
  <p class="meta">version ${escape(snap.build.version)} · node ${escape(snap.build.nodeVersion)} · env ${escape(snap.build.environment)}</p>
</header>
<main>
  <section>
    <h2>Payer daemon</h2>
    <p class="${snap.payerDaemon.healthy ? 'ok' : 'fail'}">${snap.payerDaemon.healthy ? 'healthy' : 'unhealthy'}</p>
  </section>
  <section>
    <h2>Nodes (${snap.nodes.length})</h2>
    <table>
      <thead><tr><th>id</th><th>url</th><th>status</th></tr></thead>
      <tbody>
        ${snap.nodes
          .map(
            (n) => `<tr class="${n.status}"><td>${escape(n.id)}</td><td>${escape(n.url)}</td><td>${escape(n.status)}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </section>
</main>
</body>
</html>`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const STYLE_CSS = `
body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 24px; color: #111; background: #fafafa; }
header { border-bottom: 1px solid #ddd; padding-bottom: 12px; margin-bottom: 24px; }
header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
header .meta { margin: 0; color: #666; font-size: 12px; }
main section { background: #fff; padding: 16px; border: 1px solid #e5e5e5; border-radius: 6px; margin-bottom: 16px; }
main h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.ok { color: #1a7f37; }
.fail { color: #cf222e; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
table th, table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f0f0f0; }
tr.healthy td:last-child { color: #1a7f37; }
tr.degraded td:last-child { color: #9a6700; }
tr.circuit_broken td:last-child { color: #cf222e; font-weight: 600; }
`;
