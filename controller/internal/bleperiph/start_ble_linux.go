//go:build ble && linux

// Real BlueZ (Linux/Pi) radio glue — compiled with `-tags ble` on Linux
// only. STATUS: compiles and follows the tinygo.org/x/bluetooth v0.15.0
// GATT-server API, but has NOT been validated against real hardware; the
// framing/session/verification layers underneath are fully tested without
// a radio. Known limitations of this stack (documented, acceptable for the
// single-user-at-the-gate scenario):
//
//   - Notifications on tx go to every subscribed central; the session model
//     therefore assumes ONE active central at a time (a second concurrent
//     central shares the tx stream and both exchanges will fail cleanly —
//     signatures and single-use cnonces prevent any cross-talk authority).
//   - The stack exposes no per-connection MTU, so frames are chunked to
//     cfg.MTU (default 20 = ATT 23 − 3), which every central supports.
//   - The server cannot force-drop a central; "drop the connection" is
//     implemented as session teardown — further writes start a new session.
package bleperiph

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"tinygo.org/x/bluetooth"

	"github.com/vul-os/lintel/controller/internal/blesession"
	"github.com/vul-os/lintel/controller/internal/framing"
)

// txConn adapts the tx characteristic to blesession.Conn.
type txConn struct {
	mtu   int
	char  *bluetooth.Characteristic
	mu    sync.Mutex
	onEnd func()
}

func (c *txConn) SendMessage(msg []byte) error {
	chunks, err := framing.Chunk(msg, c.mtu)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ch := range chunks {
		if _, err := c.char.Write(ch); err != nil {
			return err
		}
	}
	return nil
}

func (c *txConn) Close() error {
	if c.onEnd != nil {
		c.onEnd()
	}
	return nil
}

// Start brings up the BLE peripheral and blocks until ctx is done.
func Start(ctx context.Context, cfg Config) error {
	mtu := cfg.MTU
	if mtu == 0 {
		mtu = DefaultMTU
	}
	adapter := bluetooth.DefaultAdapter
	if err := adapter.Enable(); err != nil {
		return err
	}
	svcUUID, err := bluetooth.ParseUUID(ServiceUUID)
	if err != nil {
		return err
	}
	rxUUID, _ := bluetooth.ParseUUID(RxUUID)
	txUUID, _ := bluetooth.ParseUUID(TxUUID)
	infoUUID, _ := bluetooth.ParseUUID(InfoUUID)

	info, _ := json.Marshal(map[string]any{"v": 0, "device_id": cfg.DeviceID, "mtu": mtu})

	var tx bluetooth.Characteristic
	var mu sync.Mutex
	var sess *blesession.Session
	conn := &txConn{mtu: mtu, char: &tx}
	conn.onEnd = func() {
		mu.Lock()
		sess = nil // session over; next write starts fresh
		mu.Unlock()
	}

	service := &bluetooth.Service{
		UUID: svcUUID,
		Characteristics: []bluetooth.CharacteristicConfig{
			{
				UUID:  rxUUID,
				Flags: bluetooth.CharacteristicWritePermission | bluetooth.CharacteristicWriteWithoutResponsePermission,
				WriteEvent: func(client bluetooth.Connection, offset int, value []byte) {
					mu.Lock()
					if sess == nil {
						sess = blesession.New(cfg.Exchange, cfg.Env, conn, cfg.OnRedeemed, slog.Default())
						sess.AbortPartial()
					}
					s := sess
					mu.Unlock()
					s.HandleChunk(value)
				},
			},
			{
				Handle: &tx,
				UUID:   txUUID,
				Flags:  bluetooth.CharacteristicNotifyPermission | bluetooth.CharacteristicReadPermission,
			},
			{
				UUID:  infoUUID,
				Flags: bluetooth.CharacteristicReadPermission,
				Value: info,
			},
		},
	}
	if err := adapter.AddService(service); err != nil {
		return err
	}
	adv := adapter.DefaultAdvertisement()
	if err := adv.Configure(bluetooth.AdvertisementOptions{
		LocalName:    LocalName(cfg.DeviceID),
		ServiceUUIDs: []bluetooth.UUID{svcUUID},
	}); err != nil {
		return err
	}
	if err := adv.Start(); err != nil {
		return err
	}
	slog.Info("ble peripheral advertising", "name", LocalName(cfg.DeviceID), "service", ServiceUUID)
	<-ctx.Done()
	return ctx.Err()
}
