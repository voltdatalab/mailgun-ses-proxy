-- Improve Ghost analytics backfill queries.
-- Idempotent because production may already have these indexes created manually.

SET @index_exists := (
  SELECT COUNT(1)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'NewsletterNotifications'
    AND INDEX_NAME = 'NewsletterNotifications_type_created'
);
SET @sql := IF(
  @index_exists = 0,
  'CREATE INDEX `NewsletterNotifications_type_created` ON `NewsletterNotifications` (`type`, `created`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists := (
  SELECT COUNT(1)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'NewsletterBatch'
    AND INDEX_NAME = 'NewsletterBatch_siteId'
);
SET @sql := IF(
  @index_exists = 0,
  'CREATE INDEX `NewsletterBatch_siteId` ON `NewsletterBatch` (`siteId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
