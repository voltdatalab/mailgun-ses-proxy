-- CreateTable
CREATE TABLE `NewsletterNotificationOrphan` (
    `id` VARCHAR(191) NOT NULL,
    `notificationId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `rawEvent` TEXT NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reconciledAt` DATETIME(3) NULL,

    UNIQUE INDEX `NewsletterNotificationOrphan_notificationId_key`(`notificationId`),
    INDEX `idx_newsletter_notification_orphans_message_reconciled_created`(`messageId`, `reconciledAt`, `created`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
