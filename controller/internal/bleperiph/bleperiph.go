// Package bleperiph is the BLE GATT peripheral for offline grant redemption
// (proto/grants.md §BLE GATT): service 9f0a0001-8f7c-4b62-9d5e-7acc00000001
// ("whatsacc-grant") with rx (write), tx (notify) and info (read)
// characteristics, advertised as "wacc-<first 8 hex of device_id>".
//
// Layering (all verification and framing logic lives BELOW this package and
// is fully tested without a radio):
//
//	internal/framing    – 4-byte LE length-prefix chunker/reassembler (8 KiB max)
//	internal/blesession – open→challenge→proof→result sequencing
//	internal/grants     – the shared Exchange verification core (same as LAN)
//
// The radio glue in this package is compiled only with the `ble` build tag,
// and only Linux/BlueZ (the Pi target) has a real implementation —
// tinygo.org/x/bluetooth v0.15.0 has no GATT-server support on macOS, so
// `-tags ble` on darwin builds a stub that returns ErrUnsupported. Default
// (no-tag) builds carry no bluetooth dependency at all. The radio layer has
// NOT been validated on hardware; the framing + session + verification
// layers are conformance-tested.
package bleperiph

import (
	"errors"

	"github.com/vul-os/whatsacc/controller/internal/blesession"
	"github.com/vul-os/whatsacc/controller/internal/grants"
)

// Service and characteristic UUIDs (proto/grants.md §BLE GATT).
const (
	ServiceUUID = "9f0a0001-8f7c-4b62-9d5e-7acc00000001"
	RxUUID      = "9f0a0002-8f7c-4b62-9d5e-7acc00000001"
	TxUUID      = "9f0a0003-8f7c-4b62-9d5e-7acc00000001"
	InfoUUID    = "9f0a0004-8f7c-4b62-9d5e-7acc00000001"
)

// DefaultMTU is the conservative usable payload per write/notification
// (ATT 23 − 3) used until a real MTU exchange is surfaced by the stack.
const DefaultMTU = 20

// ErrUnsupported is returned by Start on platforms without a GATT-server
// implementation (everything except Linux/BlueZ in this reference tree),
// and by all builds without the `ble` tag.
var ErrUnsupported = errors.New("bleperiph: BLE peripheral not available in this build (need `-tags ble` on Linux/BlueZ; radio layer is a documented stub elsewhere)")

// Config wires the peripheral to the shared redemption core.
type Config struct {
	DeviceID   string
	Exchange   *grants.Exchange
	Env        func() grants.Env
	OnRedeemed blesession.Redeemed
	MTU        int // 0 = DefaultMTU
}

// LocalName returns the advertised name "wacc-<first 8 hex of device_id>".
func LocalName(deviceID string) string {
	hex := make([]byte, 0, 8)
	for i := 0; i < len(deviceID) && len(hex) < 8; i++ {
		c := deviceID[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') {
			hex = append(hex, c)
		}
	}
	return "wacc-" + string(hex)
}
