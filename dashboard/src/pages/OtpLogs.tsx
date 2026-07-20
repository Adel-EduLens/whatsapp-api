import { useMemo, useState } from 'react';
import { Search, Filter, Loader2, ShieldCheck, Clock, XCircle, Ban, Server } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useQuery } from '@tanstack/react-query';
import { request } from '../services/api';
import './OtpLogs.css';

interface OtpLog {
  id: string;
  phone: string;
  code: string;
  sessionId: string;
  callbackUrl: string | null;
  status: 'pending' | 'verified' | 'expired' | 'cancelled';
  expiresAt: string;
  verifiedAt: string | null;
  createdAt: string;
}

const STATUS_ICON = {
  pending:   <Clock size={14} />,
  verified:  <ShieldCheck size={14} />,
  expired:   <XCircle size={14} />,
  cancelled: <Ban size={14} />,
};

const STATUS_LABEL = {
  pending:   'Pending',
  verified:  'Verified',
  expired:   'Expired',
  cancelled: 'Cancelled',
};

const LIMIT = 25;

export function OtpLogs() {
  useDocumentTitle('OTP Logs');
  const [statusFilter, setStatusFilter] = useState('all');
  const [instanceFilter, setInstanceFilter] = useState('all');
  const [search, setSearch]             = useState('');
  const [page, setPage]                 = useState(1);

  const { data: instances = [] } = useSessionsQuery();
  const instanceNames = useMemo(
    () => new Map(instances.map(instance => [instance.id, instance.name])),
    [instances],
  );

  const offset = (page - 1) * LIMIT;
  const queryParams = new URLSearchParams({
    limit:  String(LIMIT),
    offset: String(offset),
    ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
    ...(instanceFilter !== 'all' ? { sessionId: instanceFilter } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['otp-logs', statusFilter, instanceFilter, page],
    queryFn:  () => request<{ data: OtpLog[]; total: number }>(`/otp?${queryParams}`),
    staleTime: 15_000,
  });

  const logs: OtpLog[] = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);

  const normalizedSearch = search.toLowerCase();
  const filtered = logs.filter(l => {
    const instanceName = instanceNames.get(l.sessionId) ?? '';
    return (
      l.phone.toLowerCase().includes(normalizedSearch) ||
      l.code.toLowerCase().includes(normalizedSearch) ||
      l.id.toLowerCase().includes(normalizedSearch) ||
      l.sessionId.toLowerCase().includes(normalizedSearch) ||
      instanceName.toLowerCase().includes(normalizedSearch)
    );
  });

  const fmt = (d: string) => new Date(d).toLocaleString();
  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    if (diff < 60000)  return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  if (isLoading && logs.length === 0) {
    return (
      <div className="otp-logs-page" style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'400px' }}>
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="otp-logs-page">
      <PageHeader
        title="OTP Logs"
        subtitle={`${total.toLocaleString()} verification attempt${total !== 1 ? 's' : ''} recorded`}
      />

      {/* Filters */}
      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by phone, code, ID or instance…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="verified">Verified</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="filter-group">
          <Server size={16} />
          <select
            aria-label="Filter by instance"
            value={instanceFilter}
            onChange={e => { setInstanceFilter(e.target.value); setPage(1); }}
          >
            <option value="all">All instances</option>
            {instances.map(instance => (
              <option key={instance.id} value={instance.id}>{instance.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Stats bar */}
      <div className="otp-stats-bar">
        {(['pending','verified','expired','cancelled'] as const).map(s => {
          const count = logs.filter(l => l.status === s).length;
          return (
            <button
              key={s}
              className={`otp-stat-chip ${s} ${statusFilter === s ? 'active' : ''}`}
              onClick={() => { setStatusFilter(statusFilter === s ? 'all' : s); setPage(1); }}
            >
              {STATUS_ICON[s]}
              <span>{STATUS_LABEL[s]}</span>
              <strong>{count}</strong>
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="otp-table-container">
        <table className="otp-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Instance</th>
              <th>Phone</th>
              <th>Code</th>
              <th>Callback URL</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Verified At</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="otp-empty">
                  <ShieldCheck size={40} strokeWidth={1} />
                  <p>No OTP records found</p>
                </td>
              </tr>
            ) : (
              filtered.map(log => (
                <tr key={log.id} className={`otp-row ${log.status}`}>
                  <td>
                    <span className={`otp-status-badge ${log.status}`}>
                      {STATUS_ICON[log.status]}
                      {STATUS_LABEL[log.status]}
                    </span>
                  </td>
                  <td>
                    <span className="otp-instance" title={log.sessionId}>
                      <Server size={14} />
                      {instanceNames.get(log.sessionId) ?? log.sessionId}
                    </span>
                  </td>
                  <td className="otp-phone">{log.phone}</td>
                  <td><code className="otp-code">{log.code}</code></td>
                  <td className="otp-callback">
                    {log.callbackUrl
                      ? <span title={log.callbackUrl}>{new URL(log.callbackUrl).hostname}</span>
                      : <span className="otp-none">—</span>}
                  </td>
                  <td title={fmt(log.createdAt)}>{timeAgo(log.createdAt)}</td>
                  <td title={fmt(log.expiresAt)} className={new Date() > new Date(log.expiresAt) && log.status === 'pending' ? 'otp-overdue' : ''}>
                    {fmt(log.expiresAt)}
                  </td>
                  <td>{log.verifiedAt ? <span className="otp-verified-time">{fmt(log.verifiedAt)}</span> : <span className="otp-none">—</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span className="page-numbers">
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i + 1).map(p => (
              <button key={p} className={p === page ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
            ))}
          </span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
