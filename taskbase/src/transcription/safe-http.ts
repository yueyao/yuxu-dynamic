import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type SafeHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
};

export type SafeHttpDependencies = {
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (url: URL, address: ResolvedAddress, timeoutMs: number,
    headers: Record<string, string>, signal?: AbortSignal) => Promise<SafeHttpResponse>;
};

type RequestOptions = {
  timeoutMs: number;
  headers?: Record<string, string>;
  allowedHosts?: readonly string[];
  signal?: AbortSignal;
};

export type DownloadResult = {
  finalUrl: string;
  byteSize: number;
  sha256: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
};

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

/** 固定经过验证的 DNS 地址发起请求，防止重定向和 DNS 重绑定访问内网。 */
export type SafeHttpOptions = {
  /** 仅用于本地开发/测试：允许 HTTP 和 loopback/私网地址。生产不要开启。 */
  allowInsecure?: boolean;
};

export class SafeHttpClient {
  private readonly resolveHost: NonNullable<SafeHttpDependencies['resolveHost']>;
  private readonly request: NonNullable<SafeHttpDependencies['request']>;
  private readonly allowInsecure: boolean;

  constructor(dependencies: SafeHttpDependencies = {}, options: SafeHttpOptions = {}) {
    this.resolveHost = dependencies.resolveHost ?? resolvePublicAddresses;
    this.request = dependencies.request ?? requestPinnedAddress;
    this.allowInsecure = options.allowInsecure ?? false;
  }

  async getText(input: string, options: RequestOptions & { maxBytes: number }): Promise<{
    finalUrl: string;
    text: string;
    headers: IncomingHttpHeaders;
  }> {
    const signal = combinedSignal(options);
    const response = await this.open(input, { ...options, signal });
    const onAbort = () => response.body.destroy(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > options.maxBytes) {
          response.body.destroy();
          throw new Error('SOURCE_TOO_LARGE: 页面响应超过允许大小');
        }
        chunks.push(buffer);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    return {
      finalUrl: response.finalUrl,
      text: Buffer.concat(chunks).toString('utf8'),
      headers: response.headers,
    };
  }

  async download(input: string, destination: string,
    options: RequestOptions & { maxBytes: number }): Promise<DownloadResult> {
    const signal = combinedSignal(options);
    const response = await this.open(input, { ...options, signal });
    const declaredSize = Number(firstHeader(response.headers['content-length']));
    if (Number.isFinite(declaredSize) && declaredSize > options.maxBytes) {
      response.body.destroy();
      throw new Error('MEDIA_TOO_LARGE: 音频超过允许大小');
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const hash = createHash('sha256');
    let byteSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > options.maxBytes) {
          callback(new Error('MEDIA_TOO_LARGE: 音频超过允许大小'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(response.body, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
        { signal });
    } catch (error) {
      await unlink(destination).catch(() => {});
      throw error;
    }
    return {
      finalUrl: response.finalUrl,
      byteSize,
      sha256: hash.digest('hex'),
      contentType: firstHeader(response.headers['content-type']),
      etag: firstHeader(response.headers.etag),
      lastModified: firstHeader(response.headers['last-modified']),
    };
  }

  private async open(input: string, options: RequestOptions): Promise<SafeHttpResponse & { finalUrl: string }> {
    let current = new URL(input);
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      validateUrl(current, options.allowedHosts, this.allowInsecure);
      const addresses = await addressesForHost(current.hostname, this.resolveHost, this.allowInsecure);
      const response = await this.request(current, addresses[0], options.timeoutMs,
        options.headers ?? {}, options.signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = firstHeader(response.headers.location);
        response.body.resume();
        if (!location) throw new Error('MEDIA_DOWNLOAD_FAILED: 重定向缺少 Location');
        current = new URL(location, current);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.resume();
        throw new Error(`MEDIA_DOWNLOAD_FAILED: HTTP ${response.statusCode}`);
      }
      return { ...response, finalUrl: current.toString() };
    }
    throw new Error('MEDIA_DOWNLOAD_FAILED: 重定向次数过多');
  }
}

function validateUrl(url: URL, allowedHosts?: readonly string[], allowInsecure = false): void {
  const protocolOk = url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:');
  if (!protocolOk || url.username || url.password) {
    throw new Error(allowInsecure
      ? 'MEDIA_UNSAFE_URL: 只允许不含凭据的 HTTP(S) URL'
      : 'MEDIA_UNSAFE_URL: 只允许不含凭据的 HTTPS URL');
  }
  if (allowedHosts && !allowedHosts.some((host) => url.hostname === host ||
    url.hostname.endsWith(`.${host}`))) {
    throw new Error('MEDIA_UNSAFE_URL: URL host 不在允许范围');
  }
}

async function addressesForHost(hostname: string,
  resolver: NonNullable<SafeHttpDependencies['resolveHost']>, allowInsecure = false): Promise<ResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname);
  if (addresses.length === 0 || (!allowInsecure && addresses.some((entry) => !isPublicAddress(entry)))) {
    throw new Error('MEDIA_UNSAFE_ADDRESS: URL 解析到私网或保留地址');
  }
  return addresses;
}

function isPublicAddress(entry: ResolvedAddress): boolean {
  if (entry.family === 6 && entry.address.toLowerCase().startsWith('::ffff:')) {
    const mapped = entry.address.slice(entry.address.lastIndexOf(':') + 1);
    if (isIP(mapped) === 4) return !blocked.check(mapped, 'ipv4');
  }
  return !blocked.check(entry.address, entry.family === 4 ? 'ipv4' : 'ipv6');
}

async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const values = await lookup(hostname, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }));
}

function requestPinnedAddress(url: URL, address: ResolvedAddress, timeoutMs: number,
  headers: Record<string, string>, signal?: AbortSignal): Promise<SafeHttpResponse> {
  return new Promise((resolveRequest, reject) => {
    const lookupPinned: LookupFunction = (_hostname, _options, callback) => {
      callback(null, address.address, address.family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      headers,
      lookup: lookupPinned,
      signal,
    }, (response) => {
      resolveRequest({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('MEDIA_DOWNLOAD_FAILED: 请求超时')));
    request.on('error', reject);
    request.end();
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function combinedSignal(options: RequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('请求已中止', 'AbortError');
}
