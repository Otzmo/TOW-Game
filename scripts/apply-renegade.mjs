// Ersetzt die Regeln der Legacy-Armeen durch die "Renegade Legacy Pack"-Entwürfe (Google Docs).
// Liest je Armee das Dokument als Text, holt Einheiten (Profil, Punkte, Optionen, Sonderregeln),
// Sonderregeln und magische Gegenstände heraus und arbeitet sie in public/data/<armee>.json ein:
// Einheiten mit gleichem Namen werden ersetzt (die Kennung bleibt, damit Armeelisten passen),
// neue kommen dazu; Regel- und Gegenstandstexte aus dem Dokument ersetzen die bisherigen.
//
// Aufruf:  node scripts/apply-renegade.mjs [armee …]   (ohne Angabe: alle sieben)

import { readFile, writeFile } from 'node:fs/promises';

/** Übersicht: https://docs.google.com/document/d/16kAE-p_CWbsH0XatDPuRao6TngSw-KSweUnJa81kOXE */
const DOCS = {
  'dark-elves': '1DxVMfxgaDnemxkmqxatHZwGNv0i1rRoekbsmVKgmRmA',
  skaven: '1QAt19do6rdvZgE8E6wLxUBkxfLBwdWYncAiof01vFHQ',
  'ogre-kingdoms': '1MaoPo4ytwOQLUdWPopfVpfBt7_qC_UZD6EX7xO6Ysag',
  'chaos-dwarfs': '1ffg5nPSrhOhMSmX2vTs6_WXOCEwmxA5Hjwy8MdPFXS0',
  'daemons-of-chaos': '1PqK0inmbov-jpfeOoUq563v1IjsVNRShfnH_WM9mpYk',
  lizardmen: '10JbMnZzdadz5bT8WrTIcFzWilhbRWy-chHc6XLf9w4o',
  'vampire-counts': '19fZUYGvDSKilKPnZhLpd6ZZ8PYJWqfaapEFgs1oNeEs',
};

const PROFILE = ['M', 'WS', 'BS', 'S', 'T', 'W', 'I', 'A', 'Ld'];
const ITEM_TYPES = {
  'magic weapons': 'Magic Weapon', 'magic armour': 'Magic Armour', talismans: 'Talisman',
  'enchanted items': 'Enchanted Item', 'arcane items': 'Arcane Item', 'magic standards': 'Magic Standard',
};

const norm = (s) => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');
const slugify = (s) => s.toLowerCase().replace(/\([^)]*\)/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Zeile in Zellen zerlegen (Tabulatoren oder mehrere Leerzeichen) */
const cells = (line) => line.split(/\t| {2,}/).map((c) => c.trim()).filter(Boolean);
const isStat = (t) => /^(-|–|n\/a|\(?[+-]?\d+[+"″]?\)?|\d*D\d+(\+\d+)?|\d+\(\d+\)|[A-Z]?\d+\+?)$/i.test(t);

/** "+1 point per model" / "Free" → Kosten */
function parseCost(text) {
  if (/^free$/i.test(text.trim())) return { cost: 0, per: 'unit' };
  const m = /\+?\s*(\d+)\s*points?(?:\s*per\s*(model|unit))?/i.exec(text);
  return m ? { cost: Number(m[1]), per: m[2]?.toLowerCase() === 'model' ? 'model' : 'unit' } : null;
}

/** Einheiten: jede Profiltabelle (Kopf M WS BS S T W I A Ld) bis "Special Rules:" */
function parseUnits(lines) {
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*Troop Type:/i.test(lines[i])) continue;
    // Rückwärts bis zum Tabellenkopf: Zellen sammeln
    let j = i - 1;
    const block = [];
    while (j >= 0 && block.length < 400) {
      const c = cells(lines[j]);
      block.unshift({ line: j, cells: c });
      if (c.includes('M') && (c.includes('WS') || /^\s*M\s*$/.test(lines[j]))) break;
      j--;
    }
    // Kopfzellen M … Ld (Points) können über mehrere Zeilen verteilt sein
    const flat = block.flatMap((b) => b.cells.map((t) => ({ t, line: b.line })));
    const hStart = flat.findIndex((x) => x.t === 'M');
    if (hStart < 0) continue;
    let k = hStart;
    const header = [];
    while (k < flat.length && (PROFILE.includes(flat[k].t) || /^points?$/i.test(flat[k].t))) header.push(flat[k++].t);
    if (header.length < 9) continue;
    const hasPoints = header.some((h) => /^points?$/i.test(h));
    // Name der Einheit: letzte nichtleere Zeile vor dem Kopf
    let n = flat[hStart].line - 1;
    while (n >= 0 && !lines[n].trim()) n--;
    const name = lines[n]?.trim().replace(/\s{2,}.*$/, '') ?? '';
    // Profilzeilen: Name, 9 Werte, ggf. Punkte
    const profile = [];
    let cost = null;
    const rest = flat.slice(k).map((x) => x.t);
    let r = 0;
    while (r < rest.length) {
      const rowName = rest[r];
      if (isStat(rowName)) { r++; continue; }
      const values = rest.slice(r + 1, r + 1 + 9);
      if (values.length < 9 || !values.every(isStat)) { r++; continue; }
      const pts = hasPoints ? rest[r + 10] : undefined;
      profile.push({ name: rowName, values: values.map((v) => v.replace('–', '-')), points: pts && /^\d+$/.test(pts) ? Number(pts) : null });
      if (pts && cost === null && /^\d+$/.test(pts)) cost = Number(pts);
      r += hasPoints ? 11 : 10;
    }
    // Felder bis "Special Rules:"
    const field = (re) => {
      for (let x = i; x < Math.min(lines.length, i + 80); x++) {
        const m = re.exec(lines[x]);
        if (m) return { value: m[1].trim(), line: x };
        if (x > i && /^\s*Special Rules:/i.test(lines[x]) && !re.source.includes('Special')) break;
      }
      return null;
    };
    const troopType = /^\s*Troop Type:\s*(.*)$/i.exec(lines[i])?.[1].trim() ?? '';
    const base = /(\d+)\s*x\s*(\d+)/i.exec(field(/^\s*Base Size:\s*(.*)$/i)?.value ?? '');
    const unitSize = field(/^\s*Unit Size:\s*(.*)$/i)?.value ?? '';
    const equipment = field(/^\s*Equipment:\s*(.*)$/i)?.value ?? '';
    const rulesField = field(/^\s*Special Rules:\s*(.*)$/i);
    const options = [];
    const optStart = field(/^\s*(Options):?\s*$/i)?.line;
    if (optStart !== undefined && rulesField) {
      for (let x = optStart + 1; x < rulesField.line; x++) {
        const c = cells(lines[x].replace(/^\s*\*\s*/, ''));
        if (c.length < 2) continue;
        const cost = parseCost(c[c.length - 1]);
        if (cost) options.push({ label: `• ${c.slice(0, -1).join(' ')}`, ...cost });
      }
    }
    const specialRules = (rulesField?.value ?? '').split(',').map((s) => s.replace(/\*/g, '').trim()).filter(Boolean);
    if (name && profile.length) {
      units.push({ name, profile, cost, troopType, base: base ? { width: +base[1], depth: +base[2] } : null, unitSize, equipment, options, specialRules });
    }
  }
  return units;
}

/** Sonderregeln der Armee: Abschnitt "… Special Rules" mit Titelzeilen und Text */
function parseRules(lines) {
  // Abschnittsbeginn: der feste Einleitungssatz ("On this page you will find a full description …")
  const start = lines.findIndex((l) => /^\s*On (this page|the following pages) you will find a full description/i.test(l));
  if (start < 0) return {};
  const rules = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/Magic Items\s*$|^Lore of |Army List\s*$|Gifts & Icons\s*$/i.test(l) && i > start + 3) break;
    // Eine Zeile mit Punktkosten gehört schon zu den Gegenständen
    if (/\d+\s*points?\s*$/i.test(l)) break;
    const isTitle = l.length <= 45 && !/[.:;,]$/.test(l) && /^[A-Z]/.test(l) && !/^On this page/i.test(l);
    if (isTitle) {
      current = { name: l, text: '' };
      rules[norm(l)] = current;
    } else if (current) {
      current.text += (current.text ? '\n' : '') + l;
    }
  }
  return rules;
}

/** Magische Gegenstände: "Name    40 points" unter den Kategorien, Text bis zum nächsten Gegenstand */
function parseItems(lines) {
  // Abschnittsbeginn: der feste Einleitungssatz ("The pages that follow detail magic items …"),
  // sonst die Überschrift "<Armee> Magic Items" bzw. bei Daemons "Daemonic Gifts & Icons"
  let start = lines.findIndex((l) => /^\s*The pages that follow detail magic items/i.test(l));
  if (start < 0) {
    start = lines.findIndex((l) => cells(l).length === 1 && /^[A-Z][A-Za-z ]+ (Magic Items|Gifts & Icons)\s*$/.test(l.trim()));
  }
  if (start < 0) return [];
  const items = [];
  let type = '';
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    // Ende des Abschnitts: Überschrift am Zeilenanfang (eingerückte Tabellenköpfe wie "Special Rules" zählen nicht)
    if (!/^\s/.test(lines[i]) && cells(lines[i]).length === 1 && /Special Rules\s*$|^Lore of |Army List\s*$/i.test(l)) break;
    if (ITEM_TYPES[l.toLowerCase()]) { type = ITEM_TYPES[l.toLowerCase()]; current = null; continue; }
    // Daemons: "Chaotic Gifts", "Gifts Of Khorne", "Icons Of Nurgle" …
    if (cells(lines[i]).length === 1 && /^(\w+ )?(Gifts|Icons)( Of \w+)?$/i.test(l)) {
      type = /Icons/i.test(l) ? 'Daemonic Icon' : 'Daemonic Gift';
      current = null;
      continue;
    }
    const m = /^(.+?)(\*)?\s*\t*\s{2,}(\d+)\s*points?\s*$/i.exec(lines[i]) ?? /^(.+?)(\*)?\s+(\d+)\s*points?\s*$/i.exec(l);
    if (m && type) {
      current = { name: m[1].trim(), cost: Number(m[3]), type, text: '', table: null };
      items.push(current);
      continue;
    }
    if (!current) continue;
    // Waffentabelle: Kopf "R S AP Special Rules", danach die Zellen bis zu den Notizen bzw. zum Fließtext
    const c = cells(lines[i]);
    // Kopf beginnt mit "R"; "S", "AP" und "Special Rules" können in eigenen Zeilen folgen
    if (c[0] === 'R' || (c.includes('R') && c.includes('AP'))) {
      current.table = [];
      current.inHeader = true;
      c.splice(0, c.indexOf('R') + 1);
    }
    if (current.table && current.inHeader) {
      while (c.length && /^(S|AP|Special Rules)$/i.test(c[0])) c.shift();
      if (!c.length) continue;
      current.inHeader = false;
    }
    if (/^Notes:/i.test(l)) {
      current.text += (current.text ? '\n' : '') + l;
      if (current.table) current.tableDone = true;
      continue;
    }
    if (current.table && !current.tableDone && (l.length <= 60 || c.length > 1)) {
      current.table.push(...c.filter((x) => !/^Special Rules$/i.test(x)));
      continue;
    }
    if (l.length > 40) {
      if (current.table) current.tableDone = true;
      current.text += (current.text ? '\n' : '') + l;
    }
  }
  return items.map(({ table, tableDone, inHeader, ...it }) => ({ ...it, profiles: weaponProfile(it.name, table) }));
}

/** Waffenprofil aus den Tabellenzellen: Name, Range, S, AP, dann Sonderregeln */
function weaponProfile(name, table) {
  if (!table?.length) return [];
  const t = [...table];
  // Führende Zellen mit dem Waffennamen (ggf. mit Range in derselben Zelle) entfernen
  while (t.length && /^[A-Za-z']/.test(t[0]) && !/^(Combat|N\/A)$/i.test(t[0]) && !/^S([+-]\d)?$/.test(t[0])) {
    const rest = t[0].replace(new RegExp(`^${name.replace(/[^A-Za-z0-9 ]/g, '.')}\\s*`, 'i'), '').trim();
    if (rest && rest !== t[0] && /^(Combat|\d+["″]?)/i.test(rest)) {
      t.splice(0, 1, ...rest.split(/\s+/));
      break;
    }
    t.shift();
  }
  const [range = '', strength = '', ap = '', ...rest] = t;
  if (!range || !strength) return [];
  const rules = rest.join(' ').split(',').map((r) => r.trim()).filter(Boolean);
  return [{ name, range, strength, ap: ap === 'N/A' ? '-' : ap, rules, notes: '' }];
}

async function apply(faction) {
  const id = DOCS[faction];
  const url = `https://docs.google.com/document/d/${id}`;
  const res = await fetch(`${url}/export?format=txt`);
  if (!res.ok) throw new Error(`${faction}: Dokument nicht lesbar (${res.status})`);
  const text = (await res.text()).replace(/^﻿/, '').replace(/\r/g, '');
  const lines = text.split('\n');
  const version = /DRAFT\s+V?([\d.]+)|V(\d+\.\d+[\d.]*)/i.exec(text);
  const file = `public/data/${faction}.json`;
  const data = JSON.parse(await readFile(file, 'utf8'));

  // Regeln: Texte aus dem Dokument ersetzen bzw. ergänzen
  const docRules = parseRules(lines);
  const ruleKeyByName = new Map(Object.values(data.rules).map((r) => [norm(r.name), r.key]));
  for (const r of Object.values(docRules)) {
    const key = ruleKeyByName.get(norm(r.name)) ?? slugify(r.name);
    data.rules[key] = { key, name: r.name, text: r.text, url };
    ruleKeyByName.set(norm(r.name), key);
  }

  // Einheiten: ersetzen (gleicher Name) oder neu anlegen
  const docUnits = parseUnits(lines);
  const unitByName = new Map(Object.values(data.units).map((u) => [norm(u.name), u.slug]));
  let replaced = 0;
  let added = 0;
  // Sammeleinträge (z. B. "Commanders of the Warlord Clans" mit Warlord und Chieftain): jede Profilzeile,
  // die einer bestehenden Einheit entspricht, wird zu dieser Einheit mit eigenem Profil und Punkten
  const entries = docUnits.flatMap((u) => {
    if (unitByName.has(norm(u.name))) return [u];
    const rows = u.profile.filter((p) => unitByName.has(norm(p.name)) && p.points !== null);
    if (!rows.length) return [u];
    return rows.map((p) => ({ ...u, name: p.name, profile: [p], cost: p.points }));
  });
  for (const u of entries) {
    const existing = unitByName.get(norm(u.name));
    const slug = existing ?? slugify(u.name);
    const ruleLabels = {};
    const specialRules = u.specialRules.map((name) => {
      let key = ruleKeyByName.get(norm(name));
      if (!key) {
        // Allgemeine Regel aus dem Grundregelwerk, die das Dokument nur nennt
        key = slugify(name);
        data.rules[key] ??= { key, name: name.replace(/\s*\([^)]*\)\s*$/, ''), text: '', url: `https://tow.whfb.app/special-rules/${key}` };
        ruleKeyByName.set(norm(name), key);
      }
      if (/\(.+\)/.test(name)) ruleLabels[key] = name;
      return key;
    });
    const prev = data.units[slug] ?? {};
    data.units[slug] = {
      ...prev,
      slug,
      name: prev.name ?? u.name,
      url: prev.url ?? url,
      base: u.base ?? prev.base ?? null,
      unitSize: u.unitSize || prev.unitSize || '',
      troopType: u.troopType || prev.troopType || '',
      category: prev.category ?? '',
      profile: u.profile.map(({ name, values }) => ({ name, values })),
      equipment: u.equipment || prev.equipment || '',
      specialRules: [...new Set(specialRules)],
      ruleLabels,
      cost: u.cost ?? prev.cost ?? null,
      options: u.options.length ? u.options : prev.options ?? [],
      renegade: true,
    };
    if (existing) replaced++; else added++;
  }

  // Magische Gegenstände der Armee ersetzen bzw. ergänzen
  const docItems = parseItems(lines);
  for (const it of docItems) {
    const key = norm(it.name);
    const prev = data.items[key] ?? {};
    data.items[key] = { slug: prev.slug ?? slugify(it.name), name: it.name, type: it.type, cost: it.cost,
      costOverride: prev.costOverride ?? null, text: it.text || prev.text || '', url,
      // Waffenprofil aus der Tabelle des Dokuments, sonst das von tow.whfb.app
      ...((it.profiles.length ? it.profiles : prev.profiles) ? { profiles: it.profiles.length ? it.profiles : prev.profiles } : {}) };
  }

  data.renegade = { version: version?.[1] ?? version?.[2] ?? '', source: url, appliedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(data, null, 1));
  console.log(`${faction}: ${entries.length} Einheiten (${replaced} ersetzt, ${added} neu) · ${Object.keys(docRules).length} Regeln · ${docItems.length} Gegenstände · Version ${data.renegade.version}`);
}

const list = process.argv.slice(2);
for (const f of list.length ? list : Object.keys(DOCS)) await apply(f);
