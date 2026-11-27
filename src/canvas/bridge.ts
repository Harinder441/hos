// No network and no forms: a prompt-injected page can't carry the user's answers anywhere; it may only postMessage the card.
export const CANVAS_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'";

const BRIDGE = `<script>(()=>{const post=(m)=>parent.postMessage(Object.assign({hos:'canvas'},m),'*');const api={state:{},set(p){if(!p||typeof p!=='object')return;api.state=Object.assign({},api.state,p);post({type:'state',patch:p})},request(){post({type:'request'})},size(h){post({type:'size',height:h||Math.ceil(document.documentElement.getBoundingClientRect().height)})}};window.hosCanvas=api;addEventListener('message',(e)=>{const d=e.data;if(e.source!==parent||!d||d.hos!=='canvas'||d.type!=='init')return;api.state=d.state||{};dispatchEvent(new CustomEvent('hoscanvas',{detail:api.state}))});addEventListener('load',()=>{api.size();if(window.ResizeObserver)new ResizeObserver(()=>api.size()).observe(document.documentElement)})})();</script>`;

export function withBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + BRIDGE + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + BRIDGE + html.slice(doctype[0].length) : BRIDGE + html;
}
