import type { Store } from '../model/store';
import { playerName } from '../model/players';
import { diceHtml } from './dice';
import { onSheetChange, openedSheet } from './sheets';

const $ = (id: string) => document.getElementById(id)!;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);


/** Gemeinsames Protokoll: Aktionen, Würfe, Zugwechsel und Chat. */
export class LogPanel {
  private unread = 0;

  constructor(private store: Store, sendChat: (text: string) => void) {
    $('chat-form').onsubmit = (e) => {
      e.preventDefault();
      const input = $('chat-input') as HTMLInputElement;
      const text = input.value.trim();
      if (text) sendChat(text);
      input.value = '';
    };
    store.subscribe((_, c) => {
      if (!c.log && !c.loaded) return;
      if (c.log && openedSheet() !== 'log') this.unread++;
      this.render();
    });
    onSheetChange((name) => {
      if (name !== 'log') return;
      this.unread = 0;
      this.render();
      ($('chat-input') as HTMLInputElement).focus();
    });
    this.render();
  }

  private render(): void {
    const badge = $('log-badge');
    badge.hidden = this.unread === 0;
    badge.textContent = String(this.unread);
    if ($('sheet-log').hidden) return;
    const list = $('log-list');
    list.innerHTML = this.store.state.log.slice(-200).map((e) => {
      const time = new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const dice = e.dice?.length ? `<div class="log-dice">${e.dice.map((d) => diceHtml(d)).join('<span class="sep">→</span>')}</div>` : '';
      return `<li class="log-${e.kind}"><span class="log-meta"><span class="dot ${e.by}"></span>${playerName(e.by)} · ${time}</span>` +
        `<span class="log-text">${escapeHtml(e.text)}</span>${dice}</li>`;
    }).join('') || '<li class="empty">Nothing has happened yet.</li>';
    list.scrollTop = list.scrollHeight;
  }
}
