export type AccessPoint = {
  id: string;
  name: string;
  location: string;
  type: 'gate' | 'door' | 'barrier';
  status: 'online' | 'offline' | 'paired-pending';
  lastOpened: string;
  device: string;
};

export const accessPoints: AccessPoint[] = [
  { id: 'ap_main', name: 'Main gate', location: 'Oakridge Estate', type: 'gate', status: 'online', lastOpened: '2 min ago', device: 'ACC-01' },
  { id: 'ap_ped', name: 'Pedestrian', location: 'Oakridge Estate', type: 'gate', status: 'online', lastOpened: '8 min ago', device: 'ACC-02' },
  { id: 'ap_park', name: 'Parking barrier', location: 'Oakridge Estate', type: 'barrier', status: 'online', lastOpened: '1 hr ago', device: 'ACC-03' },
  { id: 'ap_lobby', name: 'Lobby', location: '50 Riebeek', type: 'door', status: 'online', lastOpened: '12 min ago', device: 'ACC-08' },
  { id: 'ap_garage', name: 'Garage', location: '50 Riebeek', type: 'door', status: 'offline', lastOpened: '4 hr ago', device: 'ACC-09' },
  { id: 'ap_house', name: 'Front gate', location: 'House Bertrand', type: 'gate', status: 'online', lastOpened: '1 hr ago', device: 'ACC-12' },
  { id: 'ap_yard', name: 'Yard barrier', location: 'Workshop yard', type: 'barrier', status: 'paired-pending', lastOpened: '—', device: 'ACC-04' },
];
