import { ChangeDetectionStrategy, Component, HostListener, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { Bip110DeploymentInfo } from '@interfaces/node-api.interface';

@Component({
  selector: 'app-bip110-deployment',
  templateUrl: './bip110-deployment.component.html',
  styleUrls: ['./bip110-deployment.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Bip110DeploymentComponent implements OnInit {
  deployment$: Observable<Bip110DeploymentInfo>;
  isLoading$: Observable<boolean>;
  bip110ScanProgress$: Observable<number>;

  signalingModalOpen = false;

  constructor(
    private stateService: StateService,
  ) {}

  ngOnInit(): void {
    this.deployment$ = this.stateService.bip110Deployment$;
    this.isLoading$ = this.stateService.isLoadingWebSocket$;
    this.bip110ScanProgress$ = this.stateService.loadingIndicators$.pipe(
      map(indicators => indicators['bip110-scan'] !== undefined ? indicators['bip110-scan'] : -1)
    );
  }

  openSignalingModal(): void {
    this.signalingModalOpen = true;
  }

  closeSignalingModal(): void {
    this.signalingModalOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.signalingModalOpen) {
      this.closeSignalingModal();
    }
  }

  trackByHeight(index: number, block: { height: number; time: number }): number {
    return block.height;
  }
}
