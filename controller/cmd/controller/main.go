// Command controller is the lintel reference controller agent: pairs to a
// gateway with a claim token on first run (persisting the PINNED gateway
// key), then maintains the outbound WSS connection, processes signed
// commands fail-closed, serves offline grants on the LAN (and BLE with
// `-tags ble` on Linux), and drains the durable event queue.
//
// First run:
//
//	controller --state /var/lib/lintel --gateway https://gate.example.com --claim-token …
//
// Subsequent runs need only --state; the pairing is durable.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/vul-os/lintel/controller/internal/agent"
)

const firmware = "0.1.0"

func main() {
	var (
		stateDir   = flag.String("state", "./controller-state", "durable state directory (identity, pairing, queue)")
		gateway    = flag.String("gateway", "", "gateway base URL (first-run pairing only)")
		claimToken = flag.String("claim-token", "", "single-use claim token (first-run pairing only)")
		lanAddr    = flag.String("lan", ":8737", "LAN grant listener address (empty to disable)")
		aps        = flag.String("access-points", "main", "comma-separated access points this controller serves")
		insecure   = flag.Bool("insecure", false, "allow ws:// and http:// gateway endpoints (dev only)")
		ble        = flag.Bool("ble", false, "enable the BLE peripheral (requires a `-tags ble` Linux build)")
	)
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(log)

	a, err := agent.New(agent.Options{
		StateDir:      *stateDir,
		GatewayURL:    *gateway,
		ClaimToken:    *claimToken,
		LANAddr:       *lanAddr,
		AccessPoints:  splitNonEmpty(*aps),
		Log:           log,
		AllowInsecure: *insecure,
		Firmware:      firmware,
		EnableBLE:     *ble,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "controller:", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := a.Run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "controller:", err)
		os.Exit(1)
	}
}

func splitNonEmpty(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
