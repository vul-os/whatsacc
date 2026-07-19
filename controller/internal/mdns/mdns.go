// Package mdns is a minimal, best-effort mDNS (RFC 6762) responder that
// advertises the controller's LAN grant listener as _whatsacc._tcp.local
// with TXT ["device=<device_id>", "proto=0"] (proto/grants.md §LAN). It is
// std-lib only: a hand-rolled DNS encoder/decoder covering exactly the
// PTR/SRV/TXT/A records this service needs. Advertising failures are logged
// and non-fatal — the LAN listener still works via a directly-entered
// address, and the chat/portal paths are unaffected.
package mdns

import (
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"time"
)

const (
	mdnsAddr    = "224.0.0.251:5353"
	serviceName = "_whatsacc._tcp.local."
	ttlSeconds  = 120
)

// Advertiser answers PTR queries for _whatsacc._tcp and announces on start.
type Advertiser struct {
	Instance string // instance label, e.g. "wacc-de71ce00"
	Port     uint16 // LAN listener TCP port
	TXT      []string
	Log      *slog.Logger
}

// Serve joins the mDNS multicast group and responds until ctx is done.
func (a *Advertiser) Serve(ctx context.Context) error {
	log := a.Log
	if log == nil {
		log = slog.Default()
	}
	gaddr, err := net.ResolveUDPAddr("udp4", mdnsAddr)
	if err != nil {
		return err
	}
	conn, err := net.ListenMulticastUDP("udp4", nil, gaddr)
	if err != nil {
		return fmt.Errorf("mdns: join multicast: %w", err)
	}
	defer conn.Close()
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	// Unsolicited announcements (RFC 6762 §8.3): a few on start.
	for i := 0; i < 3; i++ {
		if msg := a.buildResponse(0); msg != nil {
			if _, err := conn.WriteTo(msg, gaddr); err != nil {
				log.Debug("mdns announce failed", "err", err)
			}
		}
		time.Sleep(250 * time.Millisecond)
	}

	buf := make([]byte, 9000)
	for {
		n, src, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !isQueryFor(buf[:n], serviceName) {
			continue
		}
		id := binary.BigEndian.Uint16(buf[:2])
		// Multicast responses use ID 0; legacy unicast queries (source
		// port != 5353) get a direct reply echoing the ID.
		if src.Port == 5353 {
			id = 0
		}
		msg := a.buildResponse(id)
		if msg == nil {
			continue
		}
		dst := gaddr
		if src.Port != 5353 {
			dst = src
		}
		if _, err := conn.WriteTo(msg, dst); err != nil {
			log.Debug("mdns respond failed", "err", err)
		}
	}
}

// isQueryFor reports whether the packet is a DNS query containing a PTR (or
// ANY) question for name.
func isQueryFor(pkt []byte, name string) bool {
	if len(pkt) < 12 {
		return false
	}
	flags := binary.BigEndian.Uint16(pkt[2:4])
	if flags&0x8000 != 0 { // QR=1 → response, ignore
		return false
	}
	qd := int(binary.BigEndian.Uint16(pkt[4:6]))
	off := 12
	for i := 0; i < qd; i++ {
		qname, n := decodeName(pkt, off)
		if n < 0 {
			return false
		}
		off += n
		if off+4 > len(pkt) {
			return false
		}
		qtype := binary.BigEndian.Uint16(pkt[off : off+2])
		off += 4
		if strings.EqualFold(qname, name) && (qtype == 12 /*PTR*/ || qtype == 255 /*ANY*/) {
			return true
		}
	}
	return false
}

// decodeName reads a possibly-compressed DNS name, returning the dotted
// name and the bytes consumed at off (-1 on malformed input).
func decodeName(pkt []byte, off int) (string, int) {
	var parts []string
	consumed := 0
	jumped := false
	jumps := 0
	i := off
	for {
		if i >= len(pkt) || jumps > 8 {
			return "", -1
		}
		l := int(pkt[i])
		switch {
		case l == 0:
			if !jumped {
				consumed = i - off + 1
			}
			return strings.Join(parts, ".") + ".", consumed
		case l&0xC0 == 0xC0:
			if i+1 >= len(pkt) {
				return "", -1
			}
			ptr := int(binary.BigEndian.Uint16(pkt[i:i+2]) & 0x3FFF)
			if !jumped {
				consumed = i - off + 2
			}
			jumped = true
			jumps++
			i = ptr
		default:
			if i+1+l > len(pkt) {
				return "", -1
			}
			parts = append(parts, string(pkt[i+1:i+1+l]))
			i += 1 + l
		}
	}
}

// buildResponse assembles PTR + SRV + TXT + A for our instance.
func (a *Advertiser) buildResponse(id uint16) []byte {
	ip := localIPv4()
	if ip == nil {
		return nil
	}
	instance := a.Instance + "." + serviceName // wacc-x._whatsacc._tcp.local.
	host := a.Instance + ".local."             // wacc-x.local.
	var b []byte
	b = binary.BigEndian.AppendUint16(b, id)
	b = binary.BigEndian.AppendUint16(b, 0x8400) // QR=1, AA=1
	b = binary.BigEndian.AppendUint16(b, 0)      // QD
	b = binary.BigEndian.AppendUint16(b, 4)      // AN
	b = binary.BigEndian.AppendUint16(b, 0)      // NS
	b = binary.BigEndian.AppendUint16(b, 0)      // AR

	// PTR _whatsacc._tcp.local → instance
	b = appendName(b, serviceName)
	b = appendRRHeader(b, 12, uint32(ttlSeconds), false)
	b = appendUint16Len(b, appendName(nil, instance))
	// SRV instance → host:port
	b = appendName(b, instance)
	b = appendRRHeader(b, 33, ttlSeconds, true)
	srv := make([]byte, 6)
	binary.BigEndian.PutUint16(srv[4:], a.Port)
	srv = append(srv, appendName(nil, host)...)
	b = appendUint16Len(b, srv)
	// TXT instance
	b = appendName(b, instance)
	b = appendRRHeader(b, 16, ttlSeconds, true)
	var txt []byte
	for _, kv := range a.TXT {
		if len(kv) > 255 {
			continue
		}
		txt = append(txt, byte(len(kv)))
		txt = append(txt, kv...)
	}
	if len(txt) == 0 {
		txt = []byte{0}
	}
	b = appendUint16Len(b, txt)
	// A host → ip
	b = appendName(b, host)
	b = appendRRHeader(b, 1, ttlSeconds, true)
	b = appendUint16Len(b, ip.To4())
	return b
}

func appendName(b []byte, name string) []byte {
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		b = append(b, byte(len(label)))
		b = append(b, label...)
	}
	return append(b, 0)
}

// appendRRHeader writes TYPE, CLASS (IN, cache-flush bit when unique), TTL.
func appendRRHeader(b []byte, typ uint16, ttl uint32, unique bool) []byte {
	b = binary.BigEndian.AppendUint16(b, typ)
	class := uint16(1)
	if unique {
		class |= 0x8000
	}
	b = binary.BigEndian.AppendUint16(b, class)
	return binary.BigEndian.AppendUint32(b, ttl)
}

func appendUint16Len(b, rdata []byte) []byte {
	b = binary.BigEndian.AppendUint16(b, uint16(len(rdata)))
	return append(b, rdata...)
}

// localIPv4 picks a non-loopback IPv4 address to advertise.
func localIPv4() net.IP {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	for _, addr := range addrs {
		if ipn, ok := addr.(*net.IPNet); ok && !ipn.IP.IsLoopback() {
			if v4 := ipn.IP.To4(); v4 != nil {
				return v4
			}
		}
	}
	return nil
}
