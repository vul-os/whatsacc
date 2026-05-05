export type Role = 'owner' | 'admin' | 'member' | 'guest';

export type Member = {
  id: string;
  name: string;
  phone: string;
  role: Role;
  location: string;
  joined: string;
  last: string;
};

export const members: Member[] = [
  { id: 'm1', name: 'Yusuf Adams', phone: '+27 82 555 0144', role: 'owner', location: 'Oakridge Estate', joined: '4 mo', last: 'today' },
  { id: 'm2', name: 'Nia Mokoena', phone: '+27 71 555 0192', role: 'admin', location: 'Oakridge Estate', joined: '4 mo', last: 'today' },
  { id: 'm3', name: 'Sasha Levin', phone: '+27 83 555 1187', role: 'admin', location: '50 Riebeek', joined: '6 wk', last: 'today' },
  { id: 'm4', name: 'Carla de Beer', phone: '+27 84 555 0431', role: 'member', location: 'House Bertrand', joined: '2 wk', last: 'yesterday' },
  { id: 'm5', name: 'Tumi Khoza', phone: '+27 79 555 6604', role: 'member', location: 'Oakridge Estate', joined: '3 mo', last: '3d ago' },
  { id: 'm6', name: 'Pieter Botes', phone: '+27 72 555 9911', role: 'guest', location: 'Workshop yard', joined: 'today', last: 'just now' },
];
