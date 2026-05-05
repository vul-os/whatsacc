export type ActivityKind = 'open' | 'denied' | 'paired' | 'invite' | 'note';

export type Activity = {
  id: string;
  time: string;
  who: string;
  where: string;
  kind: ActivityKind;
  note?: string;
};

export const activity: Activity[] = [
  { id: 'a1', time: '14:02', who: 'Yusuf A.', where: 'Oakridge · Main gate', kind: 'open' },
  { id: 'a2', time: '13:58', who: 'Nia M.', where: 'Oakridge · Pedestrian', kind: 'open' },
  { id: 'a3', time: '13:41', who: '+27 71 ••• 0192', where: 'Oakridge · Main', kind: 'denied', note: 'outside geofence' },
  { id: 'a4', time: '13:30', who: 'Owner', where: 'Workshop yard', kind: 'paired', note: 'paired ACC-04' },
  { id: 'a5', time: '12:14', who: 'Sasha L.', where: '50 Riebeek · Lobby', kind: 'open' },
  { id: 'a6', time: '11:58', who: 'Owner', where: 'Oakridge', kind: 'invite', note: 'invited 3 members' },
  { id: 'a7', time: '10:46', who: 'Carla D.', where: 'House Bertrand', kind: 'open' },
];
