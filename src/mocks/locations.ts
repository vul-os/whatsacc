export type LocationKind = 'house' | 'complex' | 'building' | 'other';

export type Location = {
  id: string;
  name: string;
  kind: LocationKind;
  city: string;
  members: number;
  accessPoints: number;
  lastOpened: string;
};

export const locations: Location[] = [
  {
    id: 'loc_oak',
    name: 'Oakridge Estate',
    kind: 'complex',
    city: 'Cape Town',
    members: 124,
    accessPoints: 4,
    lastOpened: '2 min ago',
  },
  {
    id: 'loc_50r',
    name: '50 Riebeek',
    kind: 'building',
    city: 'Cape Town',
    members: 58,
    accessPoints: 2,
    lastOpened: '11 min ago',
  },
  {
    id: 'loc_hb',
    name: 'House Bertrand',
    kind: 'house',
    city: 'Stellenbosch',
    members: 4,
    accessPoints: 1,
    lastOpened: '1 hr ago',
  },
  {
    id: 'loc_ws',
    name: 'Workshop yard',
    kind: 'other',
    city: 'Paarl',
    members: 7,
    accessPoints: 1,
    lastOpened: '3 hr ago',
  },
];
