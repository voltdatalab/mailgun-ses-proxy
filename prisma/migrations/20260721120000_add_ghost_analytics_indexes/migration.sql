-- Clean installs receive the Prisma-mapped names below. Existing installations may
-- have an equivalent index under a legacy name; that non-destructive drift is
-- intentionally reused rather than renamed, dropped, or duplicated.
--
-- An expected name with a different definition is unsafe drift. The prepared
-- statement deliberately references a non-existent information_schema sentinel
-- in that case, so the migration aborts without DDL. The sentinel is in the
-- system metadata schema and cannot be supplied by an application schema; its
-- fixed name makes the failure clear without exposing observed metadata.
-- Runtime compatibility and lock behavior must still be exercised in Task 12/14.

-- NewsletterNotifications(type, created, id), non-unique
SET @analytics_expected_name_exists := (
    SELECT EXISTS(
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterNotifications'
          AND INDEX_NAME = 'idx_notifications_type_created_id'
    )
);
SET @analytics_expected_name_matches := (
    SELECT COALESCE(
        (
            SELECT COUNT(*) = 3
               AND MIN(NON_UNIQUE) = 1
               AND MAX(NON_UNIQUE) = 1
               AND GROUP_CONCAT(
                    CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                    ORDER BY SEQ_IN_INDEX SEPARATOR ','
               ) = '1:type,2:created,3:id'
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'NewsletterNotifications'
              AND INDEX_NAME = 'idx_notifications_type_created_id'
        ),
        0
    )
);
SET @analytics_equivalent_definition_exists := EXISTS(
    SELECT 1
    FROM (
        SELECT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterNotifications'
          AND INDEX_NAME <> 'idx_notifications_type_created_id'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 3
           AND MIN(NON_UNIQUE) = 1
           AND MAX(NON_UNIQUE) = 1
           AND GROUP_CONCAT(
                CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                ORDER BY SEQ_IN_INDEX SEPARATOR ','
           ) = '1:type,2:created,3:id'
    ) AS analytics_equivalent_indexes
);
SET @analytics_index_sql := IF(
    @analytics_expected_name_exists = 1 AND @analytics_expected_name_matches = 0,
    'SELECT * FROM information_schema.__analytics_index_definition_mismatch_notifications__',
    IF(
        @analytics_expected_name_matches = 1 OR @analytics_equivalent_definition_exists = 1,
        'SELECT 1',
        'CREATE INDEX `idx_notifications_type_created_id` ON `NewsletterNotifications` (`type`, `created`, `id`)'
    )
);
PREPARE analytics_index_statement FROM @analytics_index_sql;
EXECUTE analytics_index_statement;
DEALLOCATE PREPARE analytics_index_statement;

-- NewsletterBatch(siteId), non-unique
SET @analytics_expected_name_exists := (
    SELECT EXISTS(
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterBatch'
          AND INDEX_NAME = 'NewsletterBatch_siteId_idx'
    )
);
SET @analytics_expected_name_matches := (
    SELECT COALESCE(
        (
            SELECT COUNT(*) = 1
               AND MIN(NON_UNIQUE) = 1
               AND MAX(NON_UNIQUE) = 1
               AND GROUP_CONCAT(
                    CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                    ORDER BY SEQ_IN_INDEX SEPARATOR ','
               ) = '1:siteId'
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'NewsletterBatch'
              AND INDEX_NAME = 'NewsletterBatch_siteId_idx'
        ),
        0
    )
);
SET @analytics_equivalent_definition_exists := EXISTS(
    SELECT 1
    FROM (
        SELECT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterBatch'
          AND INDEX_NAME <> 'NewsletterBatch_siteId_idx'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 1
           AND MIN(NON_UNIQUE) = 1
           AND MAX(NON_UNIQUE) = 1
           AND GROUP_CONCAT(
                CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                ORDER BY SEQ_IN_INDEX SEPARATOR ','
           ) = '1:siteId'
    ) AS analytics_equivalent_indexes
);
SET @analytics_index_sql := IF(
    @analytics_expected_name_exists = 1 AND @analytics_expected_name_matches = 0,
    'SELECT * FROM information_schema.__analytics_index_definition_mismatch_batch__',
    IF(
        @analytics_expected_name_matches = 1 OR @analytics_equivalent_definition_exists = 1,
        'SELECT 1',
        'CREATE INDEX `NewsletterBatch_siteId_idx` ON `NewsletterBatch` (`siteId`)'
    )
);
PREPARE analytics_index_statement FROM @analytics_index_sql;
EXECUTE analytics_index_statement;
DEALLOCATE PREPARE analytics_index_statement;
