import type { HosClient } from '../api/client.js';
import type { NewSnag, Snag, SnagFilter, SnagLink, SnagSummary } from './types.js';

export class SnagsClient {
  constructor(private readonly hos: HosClient) {}

  list(state: SnagFilter = 'all'): Promise<Snag[]> {
    return this.hos.request('GET', `/api/snags?state=${state}`);
  }

  summary(): Promise<SnagSummary> {
    return this.hos.request('GET', '/api/snags/summary');
  }

  get(ref: string): Promise<Snag> {
    return this.hos.request('GET', `/api/snags/${encodeURIComponent(ref)}`);
  }

  add(snag: NewSnag): Promise<Snag> {
    return this.hos.request('POST', '/api/snags', snag);
  }

  resolve(ref: string, note?: string): Promise<Snag> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/resolve`, note ? { note } : {});
  }

  edit(ref: string, text: string): Promise<Snag> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/edit`, { text });
  }

  comment(ref: string, text: string): Promise<Snag> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/comment`, { text });
  }

  reopen(ref: string): Promise<Snag> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/reopen`, {});
  }

  remove(ref: string): Promise<{ deleted: string }> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/delete`, {});
  }

  startTopic(ref: string): Promise<SnagLink> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/topic`, {});
  }

  chatInTopic(ref: string, topicId: string): Promise<SnagLink> {
    return this.hos.request('POST', `/api/snags/${encodeURIComponent(ref)}/chat`, { topicId });
  }

  fileUrl(ref: string, name: string): string {
    return `/api/snags/${encodeURIComponent(ref)}/files/${encodeURIComponent(name)}`;
  }
}
