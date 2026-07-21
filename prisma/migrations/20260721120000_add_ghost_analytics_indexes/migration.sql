-- Production schemas may already contain these indexes outside Prisma migration history.
-- MySQL/MariaDB do not share portable conditional-index syntax, so inspect
-- the current schema and execute DDL only for an absent exact index name.

SET @analytics_index_exists := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'NewsletterNotifications'
      AND INDEX_NAME = 'idx_notifications_type_created_id'
);
SET @analytics_index_sql := IF(
    @analytics_index_exists = 0,
    'CREATE INDEX `idx_notifications_type_created_id` ON `NewsletterNotifications` (`type`, `created`, `id`)',
    'SELECT 1'
);
PREPARE analytics_index_statement FROM @analytics_index_sql;
EXECUTE analytics_index_statement;
DEALLOCATE PREPARE analytics_index_statement;

SET @analytics_index_exists := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'NewsletterBatch'
      AND INDEX_NAME = 'NewsletterBatch_siteId_idx'
);
SET @analytics_index_sql := IF(
    @analytics_index_exists = 0,
    'CREATE INDEX `NewsletterBatch_siteId_idx` ON `NewsletterBatch` (`siteId`)',
    'SELECT 1'
);
PREPARE analytics_index_statement FROM @analytics_index_sql;
EXECUTE analytics_index_statement;
DEALLOCATE PREPARE analytics_index_statement;
