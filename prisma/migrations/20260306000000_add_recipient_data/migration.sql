-- AlterTable
ALTER TABLE `NewsletterMessages` ADD COLUMN `recipientData` TEXT NULL;

-- AlterTable
ALTER TABLE `NewsletterErrors` ADD COLUMN `recipientData` TEXT NULL;
