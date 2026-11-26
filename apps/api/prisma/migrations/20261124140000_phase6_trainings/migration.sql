-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ATTENDANCE_FINALIZATION_REMINDER';

-- CreateIndex
CREATE UNIQUE INDEX "trainings_series_occurrence" ON "trainings"("series_id", "starts_at") WHERE (series_id IS NOT NULL AND deleted_at IS NULL);

