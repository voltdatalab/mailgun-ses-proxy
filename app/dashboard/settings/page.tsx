"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Info, Settings, ShieldCheck } from "lucide-react"

export default function SettingsPage() {
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
                <p className="text-muted-foreground">
                    Review how application configuration is managed.
                </p>
            </div>

            <div className="grid gap-8 lg:grid-cols-3">
                <div className="lg:col-span-2 space-y-6">
                    <Card className="border-muted/50">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Settings className="h-5 w-5 text-primary" />
                                Application Configuration
                            </CardTitle>
                            <CardDescription>
                                Operational configuration is read-only in the dashboard.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="mx-4 mb-4 rounded-lg border bg-card/50 p-6">
                            <div className="flex gap-3 text-sm text-muted-foreground">
                                <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
                                <div className="space-y-1">
                                    <p className="font-medium text-foreground">Dashboard overrides are disabled</p>
                                    <p>
                                        Queue, SES, region, and runtime settings are managed only through the
                                        approved deployment environment. Their values are not returned to the browser.
                                    </p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-6">
                    <Card className="border-muted/50 bg-primary/5">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-sm">
                                <Info className="h-4 w-4 text-primary" />
                                Configuration Source
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-xs leading-relaxed text-muted-foreground">
                            <p>
                                The deployment environment is the single source of truth for operational settings.
                            </p>
                            <p className="rounded-md border bg-card p-3 italic">
                                Changes require the approved infrastructure workflow and may require a separately
                                authorized restart or deployment.
                            </p>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
