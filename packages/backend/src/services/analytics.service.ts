import { getOne, getMany, query } from '../lib/db';

interface DashboardStats {
  totalSwaps: number;
  activeSwaps: number;
  completedSwaps: number;
  failedSwaps: number;
  totalVolumeBtq: string;
  totalVolumeUsdt: string;
  uniqueUsers: number;
  avgCompletionTimeSec: number | null;
}

interface DailyStatsRow {
  date: string;
  total_swaps: number;
  completed_swaps: number;
  failed_swaps: number;
  volume_btq: string;
  volume_usdt: string;
  unique_users: number;
  avg_completion_time_sec: number | null;
}

interface RecentSwapRow {
  id: string;
  direction: string;
  amount_btq: string;
  amount_usdt: string;
  status: string;
  created_at: Date;
  eth_address: string;
}

export class AnalyticsService {
  async getDashboard(): Promise<DashboardStats> {
    const total = await getOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM swaps',
    );
    const active = await getOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM swaps
       WHERE status NOT IN ('completed', 'refunded', 'expired', 'failed')`,
    );
    const completed = await getOne<{ count: string }>(
      "SELECT COUNT(*) as count FROM swaps WHERE status = 'completed'",
    );
    const failed = await getOne<{ count: string }>(
      "SELECT COUNT(*) as count FROM swaps WHERE status IN ('failed', 'expired')",
    );
    const volumeBtq = await getOne<{ sum: string | null }>(
      "SELECT COALESCE(SUM(amount_btq), 0) as sum FROM swaps WHERE status = 'completed'",
    );
    const volumeUsdt = await getOne<{ sum: string | null }>(
      "SELECT COALESCE(SUM(amount_usdt), 0) as sum FROM swaps WHERE status = 'completed'",
    );
    const users = await getOne<{ count: string }>(
      'SELECT COUNT(DISTINCT user_id) as count FROM swaps',
    );
    const avgTime = await getOne<{ avg: number | null }>(
      `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))::integer as avg
       FROM swaps WHERE status = 'completed' AND completed_at IS NOT NULL`,
    );

    return {
      totalSwaps: parseInt(total?.count ?? '0'),
      activeSwaps: parseInt(active?.count ?? '0'),
      completedSwaps: parseInt(completed?.count ?? '0'),
      failedSwaps: parseInt(failed?.count ?? '0'),
      totalVolumeBtq: volumeBtq?.sum ?? '0',
      totalVolumeUsdt: volumeUsdt?.sum ?? '0',
      uniqueUsers: parseInt(users?.count ?? '0'),
      avgCompletionTimeSec: avgTime?.avg ?? null,
    };
  }

  async getDailyStats(days: number = 30): Promise<DailyStatsRow[]> {
    return getMany<DailyStatsRow>(
      `SELECT * FROM daily_stats
       WHERE date >= CURRENT_DATE - $1::integer
       ORDER BY date DESC`,
      [days],
    );
  }

  async getRecentSwaps(limit: number = 20): Promise<RecentSwapRow[]> {
    return getMany<RecentSwapRow>(
      `SELECT s.id, s.direction, s.amount_btq, s.amount_usdt, s.status, s.created_at,
              u.eth_address
       FROM swaps s
       JOIN users u ON s.user_id = u.id
       ORDER BY s.created_at DESC
       LIMIT $1`,
      [limit],
    );
  }

  async refreshDailyStats(): Promise<void> {
    await query(`
      INSERT INTO daily_stats (date, total_swaps, completed_swaps, failed_swaps,
                               volume_btq, volume_usdt, unique_users, avg_completion_time_sec)
      SELECT
        CURRENT_DATE,
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed'),
        COUNT(*) FILTER (WHERE status IN ('failed', 'expired')),
        COALESCE(SUM(amount_btq) FILTER (WHERE status = 'completed'), 0),
        COALESCE(SUM(amount_usdt) FILTER (WHERE status = 'completed'), 0),
        COUNT(DISTINCT user_id),
        AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))::integer
          FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL)
      FROM swaps
      WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + 1
      ON CONFLICT (date) DO UPDATE SET
        total_swaps = EXCLUDED.total_swaps,
        completed_swaps = EXCLUDED.completed_swaps,
        failed_swaps = EXCLUDED.failed_swaps,
        volume_btq = EXCLUDED.volume_btq,
        volume_usdt = EXCLUDED.volume_usdt,
        unique_users = EXCLUDED.unique_users,
        avg_completion_time_sec = EXCLUDED.avg_completion_time_sec
    `);
  }
}

export const analyticsService = new AnalyticsService();
