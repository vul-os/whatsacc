export type Device = {
  id: string;
  name: string;
  serial: string;
  firmware: string;
  status: 'online' | 'offline' | 'paired-pending';
  pairedAt: string;
  signal: number; // 0-100
};

export const devices: Device[] = [
  { id: 'd1', name: 'ACC-01', serial: 'A0FE-19D2', firmware: '1.4.2', status: 'online', pairedAt: '4 months ago', signal: 92 },
  { id: 'd2', name: 'ACC-02', serial: 'A0FE-19E1', firmware: '1.4.2', status: 'online', pairedAt: '4 months ago', signal: 88 },
  { id: 'd3', name: 'ACC-03', serial: 'A0FE-1A34', firmware: '1.4.2', status: 'online', pairedAt: '3 months ago', signal: 71 },
  { id: 'd4', name: 'ACC-04', serial: 'A1B2-2210', firmware: '1.4.0', status: 'paired-pending', pairedAt: 'just now', signal: 0 },
  { id: 'd5', name: 'ACC-08', serial: 'A1B2-2280', firmware: '1.4.2', status: 'online', pairedAt: '6 weeks ago', signal: 64 },
  { id: 'd6', name: 'ACC-09', serial: 'A1B2-2281', firmware: '1.3.9', status: 'offline', pairedAt: '6 weeks ago', signal: 0 },
  { id: 'd7', name: 'ACC-12', serial: 'A2C0-3001', firmware: '1.4.2', status: 'online', pairedAt: '2 weeks ago', signal: 81 },
];
