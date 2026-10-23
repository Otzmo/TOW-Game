import type { UnitState } from './model/types';

/** Testeinheiten, bis der Armeeimport fertig ist. Regeltexte sind eigene Kurzfassungen. */
export const demoUnits: UnitState[] = [
  {
    id: 'demo-chaos-warriors',
    owner: 'p1',
    models: 20,
    width: 5,
    x: 30,
    y: 30,
    rotation: 0,
    info: {
      name: 'Chaos Warriors',
      baseWidth: 30,
      baseDepth: 30,
      command: ['M', 'S', 'C'],
      profile: [
        { name: 'Chaos Warrior', values: ['4', '5', '3', '4', '4', '1', '4', '1', '8'] },
        { name: 'Champion', values: ['4', '5', '3', '4', '4', '1', '4', '2', '8'] },
      ],
      equipment: 'Handwaffen, Schilde, schwere Rüstung · Rüstung 4+ · Rettung 6+ (Chaos Armour)',
      rules: [
        { name: 'Close Order', text: 'Darf in geschlossener Formation aufgestellt werden.' },
        { name: 'Mark of Chaos Undivided', text: 'Misslungene Angst-, Panik- und Terrortests dürfen wiederholt werden.' },
        { name: 'Chaos Armour (6+)', text: 'Rettungswurf von 6+ gegen jede erlittene Verwundung.' },
      ],
    },
  },
  {
    id: 'demo-marauder-horsemen',
    owner: 'p2',
    models: 6,
    width: 3,
    x: 40,
    y: 18,
    rotation: Math.PI,
    info: {
      name: 'Marauder Horsemen',
      baseWidth: 30,
      baseDepth: 60,
      command: [],
      profile: [
        { name: 'Marauder Horsemen', values: ['-', '4', '3', '3', '3', '1', '3', '1', '6'] },
        { name: 'Warhorse', values: ['8', '3', '-', '3', '-', '-', '3', '1', '-'] },
      ],
      equipment: 'Handwaffen, Wurfspeere, leichte Rüstung, Schilde',
      rules: [
        { name: 'Fast Cavalry', text: 'Darf nach dem Marschieren eine schnelle Drehung ausführen.' },
        { name: 'Swiftstride', text: 'Zusätzliche Reichweite und Würfel bei Angriff, Flucht und Verfolgung.' },
      ],
    },
  },
];
