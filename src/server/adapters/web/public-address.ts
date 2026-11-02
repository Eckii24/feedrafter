import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { ipv4AllocatedOctets, ipv4Special, ipv6Allocated, ipv6Special } from './iana-snapshot.js';

const denied4 = ipv4Special.map(cidr => ipaddr.IPv4.parseCIDR(cidr));
const denied6 = ipv6Special.map(cidr => ipaddr.IPv6.parseCIDR(cidr));
const allocated6 = ipv6Allocated.map(cidr => ipaddr.IPv6.parseCIDR(cidr));

/** Fail closed on malformed, scoped, mapped, special, or unallocated answers. */
export function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (!family || value.includes('%')) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== 'unicast') return false;
  if (address instanceof ipaddr.IPv4) {
    return ipv4AllocatedOctets.some(([first, last]) => address.octets[0]! >= first && address.octets[0]! <= last)
      && !denied4.some(cidr => address.match(cidr));
  }
  return !address.isIPv4MappedAddress()
    && allocated6.some(cidr => address.match(cidr))
    && !denied6.some(cidr => address.match(cidr));
}
